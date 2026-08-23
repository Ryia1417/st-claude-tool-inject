/**
 * SillyTavern 扩展：Claude 工具调用注入 (st-claude-tool-inject)
 * ---------------------------------------------------------------------------
 * 在发往 Claude 格式端点的对话记录中，于自定义位置插入伪造的
 * tool_use / tool_result 记录（工具名、参数、结果全部可自定义），
 * 并提供「请求检查器」查看实际发出的请求体与注入位置。
 *
 * 典型用途：插入一条 "read_lorebook" 的调用+结果，让模型在读到对话记录时
 * 认为自己已经查过世界书，并把结果当成既成事实来使用。
 *
 * 接入点（均已对照 SillyTavern release 分支源码确认）：
 *   - public/scripts/openai.js
 *       eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun })
 *       之后 `chat` 数组被原样 return 出去 → 对该数组做 in-place splice 即可生效。
 *   - src/prompt-converters.js convertClaudeMessages()
 *       role:'assistant' + tool_calls[] → content:[{type:'tool_use', id, name, input}]
 *       role:'tool' + tool_call_id      → role:'user', content:[{type:'tool_result', ...}]
 *       未识别的 content block 会原样透传（native 模式依赖这一点）。
 *   - src/endpoints/backends/chat-completions.js
 *       useTools = Array.isArray(body.tools) && body.tools.length > 0
 *       useTools 为 false 时，convertClaudeMessages 会把 tool_use / tool_result
 *       **降级成纯 text 块** —— 所以本扩展默认把规则同时注册为真实工具。
 */

const MODULE_NAME = 'claudeToolInject';
const LOG = '[ClaudeToolInject]';

/** Claude API 对工具名的硬性约束：^[a-zA-Z0-9_-]{1,64}$ */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 需要抓取的后端生成接口 */
const GENERATE_ENDPOINTS = [
    '/api/backends/chat-completions/generate',
];

/** 请求体里必须打码的字段（键名匹配，大小写不敏感） */
const SECRET_KEY_RE = /(password|secret|api[-_]?key|apikey|bearer|credential|cookie|authorization)/i;
/** 可能泄露本机 / 私有部署信息的字段 */
const PRIVATE_KEY_RE = /(reverse_proxy|custom_url|base_url|proxy_url|endpoint|server_urls?|custom_include_headers)/i;

const POSITION_MODES = {
    depth: '深度（从末尾倒数第 N 条之前）',
    index: '绝对索引（从开头第 N 条之前）',
    before_last_user: '最后一条 user 消息之前',
    after_last_user: '最后一条 user 消息之后',
};

/**
 * 注入时机。
 *
 * request（默认）：在 openai.js:3055 那次 fetch 真正发出前改写 body。
 *   CHAT_COMPLETION_SETTINGS_READY 在 3052 行 emit，因此**所有**前端后处理脚本
 *   （noass / mergeEditor 等合并脚本、酒馆助手脚本）都已经跑完，注入内容不会再被它们改写。
 *
 * prompt：在 CHAT_COMPLETION_PROMPT_READY 注入，走 ST 的正常管线，
 *   其它扩展 / 脚本还能看到并处理这两条消息 —— 也正因如此会被合并类脚本吃掉。
 */
const INJECT_STAGES = {
    request: '请求发出前（最后一道，兼容 noass 等合并脚本）',
    prompt: 'CHAT_COMPLETION_PROMPT_READY（走正常管线，会被合并脚本改写）',
};

const DEFAULT_SETTINGS = {
    enabled: true,
    /** 'st' = 走 ST 的 OpenAI 中间格式（兼容性最好）；'native' = 直接塞原生 Claude block */
    injectFormat: 'st',
    /** 'request' | 'prompt'，见 INJECT_STAGES */
    injectStage: 'request',
    /** request 阶段：若请求体里没有 tools，就补上本扩展声明的工具，避免服务端把工具块降级成纯文本 */
    ensureTools: true,
    /** 限定 chat_completion_source，逗号分隔，留空 = 全部来源 */
    sources: 'claude,vertexai,custom',
    /** 跳过 dryRun（token 预算试算）阶段 */
    skipDryRun: true,
    debug: false,
    /** 抓取发往后端的请求体 */
    captureRequests: true,
    /** 展示时隐藏密钥 / 代理地址等敏感字段 */
    redactSecrets: true,
    rules: [],
};

const DEFAULT_RULE = {
    id: '',
    enabled: true,
    label: '新规则',
    name: 'read_lorebook',
    description: '',
    /** 工具调用前那条 assistant 消息的正文（思考 / 旁白）。留空 = 只发 tool_use，不带任何文字 */
    preface: '',
    schema: '',
    input: '{}',
    result: '',
    isError: false,
    posMode: 'depth',
    posValue: 0,
    declare: true,
    stealth: false,
    callId: '',
    expanded: true,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function randomId(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const buffer = new Uint32Array(length);
    crypto.getRandomValues(buffer);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += alphabet[buffer[i] % alphabet.length];
    }
    return out;
}

/**
 * 生成 Claude 风格的 tool_use id。
 * 注意：id 一旦生成就固定存进设置里，**不是每次请求随机生成** ——
 * 随机 id 会让注入点之后的所有 prompt cache 前缀失效。
 */
function makeCallId() {
    return `toolu_${randomId(24)}`;
}

function debugLog(...args) {
    if (getSettings().debug) {
        console.log(LOG, ...args);
    }
}

function safeParse(value) {
    if (typeof value !== 'string') return value ?? {};
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function normalizeRule(rule) {
    for (const [key, value] of Object.entries(DEFAULT_RULE)) {
        if (rule[key] === undefined) {
            rule[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
        }
    }
    if (!rule.id) rule.id = randomId(12);
    if (!rule.callId) rule.callId = makeCallId();
    if (!Object.hasOwn(POSITION_MODES, rule.posMode)) rule.posMode = 'depth';
    rule.posValue = Number.isFinite(Number(rule.posValue)) ? Math.trunc(Number(rule.posValue)) : 0;
    return rule;
}

function getSettings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = store[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
        }
    }
    if (!Object.hasOwn(INJECT_STAGES, settings.injectStage)) settings.injectStage = 'request';
    if (!Array.isArray(settings.rules)) settings.rules = [];
    settings.rules.forEach(normalizeRule);
    return settings;
}

function save() {
    ctx().saveSettingsDebounced();
}

function findRule(id) {
    return getSettings().rules.find(rule => rule.id === id) ?? null;
}

function makeLorebookTemplate() {
    return normalizeRule({
        label: '读取世界书',
        name: 'read_lorebook',
        description: 'Read the world/lorebook entries relevant to the current scene. Call this before describing any setting, faction, or named character so that established canon is respected.',
        schema: JSON.stringify({
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look up in the lorebook.' },
            },
            required: ['query'],
        }, null, 2),
        preface: '在动笔之前，先确认一下这一场涉及的既定设定。',
        input: JSON.stringify({ query: '{{char}} 所在场景的相关设定' }, null, 2),
        result: '（在这里填写你希望模型"以为自己刚查到"的世界书内容）\n\n- 条目 1: ...\n- 条目 2: ...',
        posMode: 'depth',
        posValue: 0,
    });
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

/** 对对象里所有字符串值递归执行 ST 宏替换（先 parse 后替换，避免宏输出破坏 JSON 结构）。 */
function substituteDeep(value) {
    const substituteParams = ctx().substituteParams;
    if (typeof value === 'string') return substituteParams(value);
    if (Array.isArray(value)) return value.map(substituteDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = substituteDeep(item);
        }
        return out;
    }
    return value;
}

function parseInputObject(rule) {
    const raw = String(rule.input ?? '').trim();
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn(LOG, `规则 "${rule.label}" 的调用参数不是 JSON 对象，已按 {} 处理。`);
            return {};
        }
        return parsed;
    } catch (error) {
        console.warn(LOG, `规则 "${rule.label}" 的调用参数不是合法 JSON，已按 {} 处理。`, error);
        return {};
    }
}

/**
 * 构造要插入的消息（2 ~ 3 条）。
 *
 * rule.preface 非空时，assistant 这一侧会带上一段正文，最终发到 Claude 的形状是
 * `assistant: [{type:'text'}, {type:'tool_use'}]`。多条规则串起来就是
 * 「说一句 → 调工具 → 看结果 → 再说一句 → 再调工具」的完整思考链。
 *
 * st 格式下**必须拆成两条 assistant 消息**，这不是风格问题：
 *   - prompt-converters.js:192 —— assistant 带 tool_calls 时 message.content 会被
 *     tool_use 数组**整体覆盖**，写在同一条消息里的文字会被静默丢掉；
 *   - prompt-converters.js:340 —— 随后连续同角色消息的 content 数组按顺序合并。
 * 所以「纯文字 assistant」+「纯 tool_calls assistant」合并出来，正好是想要的形状。
 *
 * native 格式没有这个限制，两个 block 放同一条消息即可。
 *
 * @param {object} rule
 * @param {'st'|'native'} format
 * @returns {object[]}
 */
function buildInjection(rule, format) {
    const input = substituteDeep(parseInputObject(rule));
    const result = ctx().substituteParams(String(rule.result ?? ''));
    const preface = ctx().substituteParams(String(rule.preface ?? '')).trim();
    const callId = rule.callId || makeCallId();

    if (format === 'native') {
        // 原生 Claude block 直通：convertClaudeMessages 对未知 type 的 block 原样返回。
        const blocks = [];
        if (preface) blocks.push({ type: 'text', text: preface });
        blocks.push({ type: 'tool_use', id: callId, name: rule.name, input });

        const toolResult = {
            type: 'tool_result',
            tool_use_id: callId,
            content: result,
        };
        if (rule.isError) toolResult.is_error = true;
        return [
            { role: 'assistant', content: blocks },
            { role: 'user', content: [toolResult] },
        ];
    }

    // ST 中间格式：由 convertClaudeMessages（Claude 源）或代理端（OpenAI 兼容源）负责转换。
    const messages = [];
    if (preface) {
        messages.push({ role: 'assistant', content: preface });
    }
    messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: rule.name, arguments: JSON.stringify(input) },
        }],
    });
    messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: result,
    });
    return messages;
}

function lastIndexOfRole(chat, role) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.role === role) return i;
    }
    return -1;
}

/**
 * 最小可插入下标：至少要有一条非 system 消息排在注入的 assistant 之前，
 * 否则 convertClaudeMessages 剥掉前导 system 后 messages[0] 会变成 assistant，
 * Claude 会直接 400。
 */
function computeMinIndex(chat) {
    const index = chat.findIndex(message => message?.role && message.role !== 'system');
    return index < 0 ? chat.length : index + 1;
}

function resolvePosition(chat, rule) {
    const total = chat.length;
    const offset = Number(rule.posValue) || 0;

    switch (rule.posMode) {
        case 'index':
            return clamp(offset, 0, total);
        case 'before_last_user': {
            const index = lastIndexOfRole(chat, 'user');
            return index < 0 ? total : clamp(index - offset, 0, total);
        }
        case 'after_last_user': {
            const index = lastIndexOfRole(chat, 'user');
            return index < 0 ? total : clamp(index + 1 + offset, 0, total);
        }
        case 'depth':
        default:
            return clamp(total - offset, 0, total);
    }
}

function activeRules() {
    return getSettings().rules.filter(rule => {
        if (!rule.enabled) return false;
        if (!TOOL_NAME_RE.test(String(rule.name || ''))) {
            console.warn(LOG, `规则 "${rule.label}" 的工具名 "${rule.name}" 不匹配 ^[a-zA-Z0-9_-]{1,64}$，已跳过。`);
            return false;
        }
        return true;
    });
}

function sourceAllowed(sourceOverride) {
    const raw = String(getSettings().sources || '').trim();
    if (!raw) return true;
    const current = String(sourceOverride ?? ctx().chatCompletionSettings?.chat_completion_source ?? '').toLowerCase();
    return raw.toLowerCase().split(',').map(part => part.trim()).filter(Boolean).includes(current);
}

/**
 * 对 chat 数组做原地注入。
 * 所有规则的位置都按 **注入前** 的数组解析，然后从后往前 splice，
 * 这样多条规则之间不会互相顶掉下标。
 * @returns {object|null} 本次注入的报告，供请求检查器展示
 */
function applyRules(chat) {
    const settings = getSettings();
    const rules = activeRules();
    if (!rules.length) return null;

    const before = chat.length;
    const minIndex = computeMinIndex(chat);
    const planned = rules.map((rule, order) => {
        const raw = resolvePosition(chat, rule);
        return { rule, order, raw, at: Math.max(minIndex, raw) };
    });

    // 位置降序；同位置时规则序降序 —— 逆序 splice 到同一下标，最终顺序才与规则列表一致。
    planned.sort((a, b) => (b.at - a.at) || (b.order - a.order));

    const injectedBy = new Map();
    for (const item of planned) {
        const messages = buildInjection(item.rule, settings.injectFormat);
        for (const message of messages) injectedBy.set(message, item.rule);
        chat.splice(item.at, 0, ...messages);
    }

    const report = {
        time: Date.now(),
        format: settings.injectFormat,
        stage: settings.injectStage,
        before,
        after: chat.length,
        minIndex,
        items: planned
            .slice()
            .sort((a, b) => a.at - b.at)
            .map(item => ({
                label: item.rule.label,
                name: item.rule.name,
                posMode: item.rule.posMode,
                posValue: item.rule.posValue,
                requestedAt: item.raw,
                resolvedAt: item.at,
                clamped: item.at !== item.raw,
                callId: item.rule.callId,
                hasPreface: Boolean(String(item.rule.preface ?? '').trim()),
            })),
        map: chat.map((message, index) => ({
            index,
            role: message?.role ?? '(无)',
            injected: injectedBy.has(message),
            injectedBy: injectedBy.get(message)?.name,
            preview: messagePreview(message),
        })),
    };

    debugLog(`注入 ${planned.length} 组工具调用记录`, report.items);
    return report;
}

function messagePreview(message) {
    if (!message) return '';
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        return `tool_calls → ${message.tool_calls.map(tc => tc?.function?.name).join(', ')}`;
    }
    const content = message.content;
    if (typeof content === 'string') {
        const flat = content.replace(/\s+/g, ' ').trim();
        return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
    }
    if (Array.isArray(content)) {
        return content.map(block => {
            if (block?.type === 'text') {
                const flat = String(block.text ?? '').replace(/\s+/g, ' ').trim();
                return `text: ${flat.length > 70 ? `${flat.slice(0, 70)}…` : flat}`;
            }
            if (block?.type === 'tool_use') return `tool_use: ${block.name}`;
            if (block?.type === 'tool_result') return `tool_result${block.is_error ? ' (is_error)' : ''}`;
            return String(block?.type ?? 'block');
        }).join(' | ');
    }
    return '';
}

// ---------------------------------------------------------------------------
// 请求检查器
// ---------------------------------------------------------------------------

const MAX_SNAPSHOTS = 8;
/** @type {Array<{id:string,time:number,url:string,body:any,report:object|null}>} */
const snapshots = [];
let pendingReport = null;
let fetchHooked = false;

function pushSnapshot(url, body, report) {
    snapshots.unshift({
        id: randomId(8),
        time: Date.now(),
        url,
        body,
        report: report ?? null,
    });
    while (snapshots.length > MAX_SNAPSHOTS) snapshots.pop();
    if ($('#ctiu_snapshot').length) renderSnapshotList();
}

/**
 * 按 OpenAI 的 tools 形状声明本扩展的工具。
 * 服务端 chat-completions.js 会 `.filter(t => t.type === 'function').map(t => t.function)`
 * 再转成 Claude 的 `{name, description, input_schema}`。
 */
function buildToolDeclarations() {
    const seen = new Set();
    const tools = [];
    for (const rule of getSettings().rules) {
        if (!rule.enabled || !rule.declare) continue;
        if (!TOOL_NAME_RE.test(String(rule.name || ''))) continue;
        if (seen.has(rule.name)) continue;
        seen.add(rule.name);
        tools.push({
            type: 'function',
            function: {
                name: rule.name,
                description: rule.description || `Injected tool: ${rule.name}`,
                parameters: parseSchema(rule),
            },
        });
    }
    return tools;
}

/**
 * request 阶段的注入：直接改写即将发出的请求体。
 * @returns {object|null} 注入报告
 */
function injectIntoRequestBody(body) {
    const settings = getSettings();
    if (settings.injectStage !== 'request') return null;
    if (!settings.enabled) return null;
    if (!Array.isArray(body?.messages)) return null;
    if (!sourceAllowed(body.chat_completion_source)) {
        debugLog('当前 API 来源不在限定列表内，跳过注入。');
        return null;
    }

    const report = applyRules(body.messages);
    if (!report) return null;

    // 服务端的判断是 useTools = Array.isArray(body.tools) && body.tools.length > 0。
    // ST 没注册工具时（函数调用关闭 / multi-swipe / impersonate 等）这里补一份，
    // 否则 convertClaudeMessages 会把刚注入的 tool_use / tool_result 压成纯文本。
    if (settings.ensureTools && !(Array.isArray(body.tools) && body.tools.length)) {
        const tools = buildToolDeclarations();
        if (tools.length) {
            body.tools = tools;
            // tool_choice 必须给值：服务端会写成 { type: request.body.tool_choice }，
            // 留空会发出非法的 { type: undefined }。
            if (!body.tool_choice) body.tool_choice = 'auto';
            report.toolsInjected = tools.map(tool => tool.function.name);
            debugLog('请求体缺少 tools，已补上：', report.toolsInjected);
        }
    }

    return report;
}

/**
 * 包一层 fetch：
 *   - request 阶段在这里完成注入（此时 CHAT_COMPLETION_SETTINGS_READY 已经 emit 完，
 *     noass / mergeEditor 之类的合并脚本都跑过了，不会再动我们插入的消息）；
 *   - 顺带把最终发出的请求体存成快照。
 * 只处理 init.body 字符串，不碰响应流，因此不影响流式输出。
 */
function installFetchHook() {
    if (fetchHooked) return;
    fetchHooked = true;

    const original = globalThis.fetch;
    globalThis.fetch = function (input, init) {
        try {
            const url = String(typeof input === 'string' ? input : (input?.url ?? ''));
            const raw = init?.body;
            if (typeof raw === 'string' && GENERATE_ENDPOINTS.some(endpoint => url.includes(endpoint))) {
                const body = JSON.parse(raw);
                const report = injectIntoRequestBody(body);

                if (report) {
                    // 只有真正改动过才重新序列化，避免无谓地动 init。
                    const patched = { ...init, body: JSON.stringify(body) };
                    if (getSettings().captureRequests) pushSnapshot(url, body, report);
                    pendingReport = null;
                    return original.call(this, input, patched);
                }

                if (getSettings().captureRequests) pushSnapshot(url, body, pendingReport);
                pendingReport = null;
            }
        } catch (error) {
            console.error(LOG, '请求钩子出错，本次请求按原样发出：', error);
        }
        return original.apply(this, arguments);
    };
    debugLog('fetch 钩子已安装');
}

/** 递归打码：密钥类字段一律隐藏，地址类字段只保留 origin。 */
function redact(value, key = '') {
    if (SECRET_KEY_RE.test(key)) return '[已隐藏]';
    if (PRIVATE_KEY_RE.test(key)) {
        if (typeof value === 'string' && value) {
            try {
                return `${new URL(value).origin}/…`;
            } catch {
                return '[已隐藏]';
            }
        }
        return '[已隐藏]';
    }
    if (Array.isArray(value)) return value.map(item => redact(item, key));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            out[childKey] = redact(childValue, childKey);
        }
        return out;
    }
    return value;
}

function maybeRedact(value) {
    return getSettings().redactSecrets ? redact(value) : value;
}

/**
 * 本地复现 src/prompt-converters.js `convertClaudeMessages()` 的核心转换，
 * 用来预估真正发往 Claude 上游的请求体。
 *
 * 说明：这是**近似**结果 —— tool_use / tool_result / 同角色合并 / useTools 降级
 * 这几条与源码一致；system 提取、name 前缀、图片 base64、prefill 等细节做了简化。
 * 想看百分之百准确的上游报文，请在你的反代 / 中转服务侧开日志。
 */
function simulateClaudeRequest(body) {
    const source = structuredClone(body?.messages ?? []);
    const useTools = Array.isArray(body?.tools) && body.tools.length > 0;

    const systemParts = [];
    while (source.length && source[0]?.role === 'system') {
        systemParts.push(String(source.shift().content ?? ''));
    }

    const merged = [];
    for (const message of source) {
        let role = message.role;
        let content = message.content;

        if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
            content = message.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name,
                input: safeParse(tc.function?.arguments),
            }));
        } else if (role === 'tool') {
            role = 'user';
            content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
        } else if (role === 'system') {
            role = 'user';
        }

        if (typeof content === 'string') {
            content = content.trim() ? [{ type: 'text', text: content }] : [];
        }
        if (!Array.isArray(content)) content = [];

        content = content.map(block => (block?.type === 'image_url'
            ? { type: 'image', source: { type: 'base64', media_type: '(由 ST 填充)', data: '<base64…>' } }
            : block));

        if (!content.length) continue;

        const previous = merged[merged.length - 1];
        if (previous && previous.role === role) {
            previous.content.push(...content);
        } else {
            merged.push({ role, content });
        }
    }

    if (!useTools) {
        // 与源码一致的降级路径：没有 tools 时 tool_use / tool_result 被压成纯文本。
        for (const message of merged) {
            for (const block of message.content) {
                if (block?.type === 'tool_use') {
                    block.type = 'text';
                    block.text = JSON.stringify(block.input);
                    delete block.id; delete block.name; delete block.input;
                }
                if (block?.type === 'tool_result') {
                    block.type = 'text';
                    block.text = block.content;
                    delete block.tool_use_id; delete block.content; delete block.is_error;
                }
            }
        }
    }

    const request = {};
    if (body?.model) request.model = body.model;
    if (body?.max_tokens) request.max_tokens = body.max_tokens;
    if (body?.temperature !== undefined) request.temperature = body.temperature;
    if (body?.stream !== undefined) request.stream = body.stream;
    if (systemParts.length) request.system = systemParts.join('\n\n');
    if (useTools) {
        request.tools = body.tools;
        if (body.tool_choice) request.tool_choice = body.tool_choice;
    }
    request.messages = merged;
    return request;
}

function currentSnapshot() {
    const id = String($('#ctiu_snapshot').val() ?? '');
    return snapshots.find(item => item.id === id) ?? snapshots[0] ?? null;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderSnapshotList() {
    const options = snapshots.length
        ? snapshots.map((item, index) => {
            const count = item.body?.messages?.length ?? 0;
            const injected = item.report?.items?.length ?? 0;
            return `<option value="${esc(item.id)}">#${snapshots.length - index} ${formatTime(item.time)} · ${count} 条消息 · 注入 ${injected} 组</option>`;
        }).join('')
        : '<option value="">（还没有抓到请求）</option>';
    const previous = String($('#ctiu_snapshot').val() ?? '');
    $('#ctiu_snapshot').html(options);
    if (previous && snapshots.some(item => item.id === previous)) {
        $('#ctiu_snapshot').val(previous);
    }
}

function buildPositionMap(snapshot) {
    const report = snapshot?.report;
    const messages = snapshot?.body?.messages;

    if (!report) {
        if (!Array.isArray(messages)) return '（这次请求没有注入记录，也没抓到消息数组）';
        const lines = messages.map((message, index) =>
            `${String(index).padStart(3, ' ')}  ${String(message?.role ?? '?').padEnd(9, ' ')}  ${messagePreview(message)}`);
        return ['（本次请求未发生注入）', '', 'idx  role       预览', ...lines].join('\n');
    }

    const header = [
        `注入时机：${INJECT_STAGES[report.stage] ?? report.stage ?? '(旧快照)'}`,
        `注入格式：${report.format}`,
        report.toolsInjected?.length
            ? `已自动补全 tools：${report.toolsInjected.join(', ')}`
            : '未自动补全 tools（请求体本来就带 tools，或该选项已关闭）',
        `注入前消息数：${report.before} → 注入后：${report.after}（+${report.after - report.before}）`,
        `最小可插入下标：${report.minIndex}（保证注入的 assistant 不会成为第一条非 system 消息）`,
        '',
        '注入点：',
        ...report.items.map(item =>
            `  · [${item.resolvedAt}] ${item.name}  ←  ${POSITION_MODES[item.posMode] ?? item.posMode}` +
            `${item.posValue ? ` / 偏移 ${item.posValue}` : ''}` +
            `${item.clamped ? `（原本解析到 ${item.requestedAt}，已上推到最小可插入位）` : ''}` +
            `${item.hasPreface ? ' · 含调用前正文（占 3 条消息）' : ''}` +
            `  (${item.label})`),
        '',
        '消息位置图（★ = 本扩展注入）：',
        'idx  ★  role       预览',
    ];

    const rows = report.map.map(row =>
        `${String(row.index).padStart(3, ' ')}  ${row.injected ? '★' : ' '}  ${String(row.role).padEnd(9, ' ')}  ${row.preview}`);

    return [...header, ...rows].join('\n');
}

function showInspector(mode) {
    const snapshot = currentSnapshot();
    const pre = $('#ctiu_inspect_out');

    if (mode === 'hide') {
        pre.hide();
        return;
    }

    if (!snapshot) {
        pre.text('还没有抓到请求。请确认「抓取请求体」已开启，然后发一条消息。').show();
        return;
    }

    switch (mode) {
        case 'map':
            pre.text(buildPositionMap(snapshot)).show();
            break;
        case 'st':
            pre.text([
                `// POST ${snapshot.url}`,
                '// SillyTavern 前端 → SillyTavern 后端 的原始请求体（真实抓取）',
                JSON.stringify(maybeRedact(snapshot.body), null, 2),
            ].join('\n')).show();
            break;
        case 'upstream':
            pre.text([
                '// 预估的上游 Claude Messages API 请求体',
                '// 依据 src/prompt-converters.js convertClaudeMessages() 的规则本地复现：',
                '// tool_use / tool_result / 同角色合并 / useTools 降级 与源码一致；',
                '// system 提取、name 前缀、图片 base64、prefill 等细节为简化实现，仅供核对结构。',
                JSON.stringify(maybeRedact(simulateClaudeRequest(snapshot.body)), null, 2),
            ].join('\n')).show();
            break;
    }
}

function downloadCurrent() {
    const snapshot = currentSnapshot();
    if (!snapshot) {
        toastr.warning('还没有抓到请求');
        return;
    }
    const payload = {
        capturedAt: new Date(snapshot.time).toISOString(),
        endpoint: snapshot.url,
        injection: snapshot.report,
        stRequestBody: maybeRedact(snapshot.body),
        estimatedUpstreamBody: maybeRedact(simulateClaudeRequest(snapshot.body)),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `claude-tool-inject-${snapshot.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

async function copyCurrentView() {
    const text = $('#ctiu_inspect_out').text();
    if (!text) {
        toastr.warning('先点上面的按钮生成内容');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('已复制到剪贴板');
    } catch (error) {
        toastr.error(`复制失败：${error.message}`);
    }
}

async function onChatCompletionPromptReady(eventData) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (settings.injectStage !== 'prompt') return;
        if (settings.skipDryRun && eventData?.dryRun) return;
        if (!Array.isArray(eventData?.chat)) return;
        if (!sourceAllowed()) {
            debugLog('当前 API 来源不在限定列表内，跳过注入。');
            return;
        }
        const report = applyRules(eventData.chat);
        if (report && !eventData?.dryRun) pendingReport = report;
    } catch (error) {
        console.error(LOG, '注入失败：', error);
    }
}

// ---------------------------------------------------------------------------
// 工具声明（让服务端 useTools=true，避免 tool_use 被降级成纯文本）
// ---------------------------------------------------------------------------

const registeredNames = new Set();

function parseSchema(rule) {
    const raw = String(rule.schema ?? '').trim();
    if (!raw) return { type: 'object', properties: {} };
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // fall through
    }
    console.warn(LOG, `规则 "${rule.label}" 的参数 Schema 不是合法 JSON 对象，已用空 schema 代替。`);
    return { type: 'object', properties: {} };
}

function syncToolRegistrations() {
    const context = ctx();
    if (typeof context.registerFunctionTool !== 'function') return;

    const wanted = new Map();
    for (const rule of getSettings().rules) {
        if (!rule.enabled || !rule.declare) continue;
        if (!TOOL_NAME_RE.test(String(rule.name || ''))) continue;
        wanted.set(rule.name, rule);
    }

    for (const name of [...registeredNames]) {
        if (!wanted.has(name)) {
            context.unregisterFunctionTool(name);
            registeredNames.delete(name);
        }
    }

    for (const [name, rule] of wanted) {
        const ruleId = rule.id;
        context.registerFunctionTool({
            name,
            displayName: rule.label || name,
            description: rule.description || `Injected tool: ${name}`,
            parameters: parseSchema(rule),
            // 模型如果"真的"调用了这个工具，就把同一份预设结果还给它。
            action: async () => {
                const live = findRule(ruleId);
                return ctx().substituteParams(String(live?.result ?? ''));
            },
            shouldRegister: async () => {
                const live = findRule(ruleId);
                return Boolean(getSettings().enabled && live?.enabled && live?.declare && sourceAllowed());
            },
            stealth: Boolean(rule.stealth),
        });
        registeredNames.add(name);
    }

    debugLog('已声明工具：', [...registeredNames]);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function previewJson(rule) {
    const settings = getSettings();
    const built = buildInjection(rule, settings.injectFormat);

    if (settings.injectFormat === 'native') {
        return JSON.stringify(built, null, 2);
    }

    // 模拟 convertClaudeMessages 的转换 + 同角色合并，方便直观核对最终线上格式。
    const input = substituteDeep(parseInputObject(rule));
    const preface = ctx().substituteParams(String(rule.preface ?? '')).trim();
    const blocks = [];
    if (preface) blocks.push({ type: 'text', text: preface });
    blocks.push({ type: 'tool_use', id: rule.callId, name: rule.name, input });

    const converted = [
        { role: 'assistant', content: blocks },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: rule.callId, content: ctx().substituteParams(String(rule.result ?? '')) }],
        },
    ];
    return [
        `// ST 内部格式（实际写入 chat 数组的 ${built.length} 条消息）`,
        JSON.stringify(built, null, 2),
        '',
        '// 经 convertClaudeMessages 转换 + 同角色合并后，发往 Claude 的内容',
        JSON.stringify(converted, null, 2),
    ].join('\n');
}

function renderStatus() {
    const context = ctx();
    const settings = getSettings();
    const source = context.chatCompletionSettings?.chat_completion_source ?? '(未知)';
    const functionCalling = Boolean(context.chatCompletionSettings?.function_calling);
    const supported = typeof context.isToolCallingSupported === 'function'
        ? Boolean(context.isToolCallingSupported())
        : false;
    const declaredCount = context.ToolManager?.tools?.length ?? 0;
    const inScope = sourceAllowed();
    const stage = settings.injectStage;
    const fallbackTools = buildToolDeclarations().length;

    const rows = [];
    rows.push(`<div><b>当前 API 来源：</b><code>${esc(source)}</code> ${inScope ? '<span class="ctiu-ok">（在限定范围内）</span>' : '<span class="ctiu-warn">（不在限定范围内，本扩展不会注入）</span>'}</div>`);
    rows.push(`<div><b>注入时机：</b>${esc(INJECT_STAGES[stage] ?? stage)}</div>`);
    rows.push(`<div><b>ST 函数调用开关：</b>${functionCalling ? '<span class="ctiu-ok">已开启</span>' : '<span class="ctiu-bad">已关闭</span>'}</div>`);
    rows.push(`<div><b>当前来源支持工具调用：</b>${supported ? '<span class="ctiu-ok">是</span>' : '<span class="ctiu-bad">否</span>'}</div>`);
    rows.push(`<div><b>已注册工具总数：</b>${declaredCount}</div>`);

    const stAlreadyOk = functionCalling && supported && declaredCount > 0;

    if (stAlreadyOk) {
        rows.push('<div class="ctiu-ok ctiu-status-note">✓ 注入内容会以真正的 tool_use / tool_result 块发送。</div>');
    } else if (stage === 'request' && settings.ensureTools && fallbackTools > 0) {
        rows.push(`<div class="ctiu-ok ctiu-status-note">✓ ST 这边没注册工具，但「自动补全 tools」已开启，发出前会补上 ${fallbackTools} 个工具声明，工具块不会被降级。</div>`);
    } else {
        rows.push('<div class="ctiu-bad ctiu-status-note">⚠ 服务端 <code>useTools</code> 会是 false，SillyTavern 会把 tool_use / tool_result <b>降级成纯文本块</b>。请在「AI 回复设置」里勾选 <b>Enable function calling</b>，或把注入时机设为「请求发出前」并开启「自动补全 tools」。</div>');
    }

    if (stage === 'prompt') {
        rows.push('<div class="ctiu-warn ctiu-status-note">注入时机为 <b>CHAT_COMPLETION_PROMPT_READY</b>：如果你在用 noass / mergeEditor 这类合并脚本（它们挂在更靠后的 <code>CHAT_COMPLETION_SETTINGS_READY</code> 上，且会丢弃 <code>tool_calls</code> / <code>tool_call_id</code>），注入的两条消息会被并进普通文本。遇到这种情况请切到「请求发出前」。</div>');
    }

    if (settings.injectFormat === 'native') {
        rows.push('<div class="ctiu-status-note">当前为 <b>native</b> 模式：直接写入原生 Claude block，仅适用于 Claude / Vertex 源，OpenAI 兼容代理会读不懂。</div>');
    }

    $('#ctiu_status').html(rows.join(''));
}

function ruleSummary(rule) {
    const mode = POSITION_MODES[rule.posMode] ?? rule.posMode;
    return `${mode}${rule.posValue ? ` · 偏移 ${rule.posValue}` : ''}`;
}

function renderRule(rule) {
    const nameValid = TOOL_NAME_RE.test(String(rule.name || ''));
    const isNative = getSettings().injectFormat === 'native';

    const modeOptions = Object.entries(POSITION_MODES)
        .map(([value, text]) => `<option value="${esc(value)}"${rule.posMode === value ? ' selected' : ''}>${esc(text)}</option>`)
        .join('');

    return `
<div class="ctiu-rule ${rule.expanded ? 'expanded' : ''}" data-id="${esc(rule.id)}">
    <div class="ctiu-rule-head">
        <label class="checkbox_label ctiu-head-toggle" title="启用此规则">
            <input type="checkbox" data-field="enabled" ${rule.enabled ? 'checked' : ''}>
        </label>
        <div class="ctiu-rule-title" data-act="toggle">
            <span class="ctiu-rule-label">${esc(rule.label || '(未命名)')}</span>
            <code class="${nameValid ? '' : 'ctiu-bad'}">${esc(rule.name || '(无工具名)')}</code>
            <small class="ctiu-rule-pos">${esc(ruleSummary(rule))}</small>
        </div>
        <div class="ctiu-rule-actions">
            <div class="menu_button fa-solid fa-eye" data-act="preview" title="预览注入内容"></div>
            <div class="menu_button fa-solid fa-clone" data-act="duplicate" title="复制规则"></div>
            <div class="menu_button fa-solid fa-trash-can" data-act="delete" title="删除规则"></div>
            <div class="menu_button fa-solid ${rule.expanded ? 'fa-chevron-up' : 'fa-chevron-down'}" data-act="toggle" title="展开 / 折叠"></div>
        </div>
    </div>
    <div class="ctiu-rule-body" ${rule.expanded ? '' : 'style="display:none"'}>
        <div class="ctiu-grid">
            <label class="ctiu-field">
                <span>规则备注（仅本地显示）</span>
                <input type="text" class="text_pole" data-field="label" value="${esc(rule.label)}">
            </label>
            <label class="ctiu-field">
                <span>工具名称 <small>必须匹配 <code>^[a-zA-Z0-9_-]{1,64}$</code></small></span>
                <input type="text" class="text_pole ${nameValid ? '' : 'ctiu-input-bad'}" data-field="name" value="${esc(rule.name)}">
            </label>
        </div>

        <label class="ctiu-field">
            <span>工具描述 <small>会随工具声明一起进系统提示词，影响模型对这个"能力"的理解</small></span>
            <textarea class="text_pole textarea_compact" rows="2" data-field="description">${esc(rule.description)}</textarea>
        </label>

        <label class="ctiu-field">
            <span>调用前的 assistant 正文 <small>模型「调用这个工具之前说的话」，支持 {{宏}}；留空则只发 tool_use。多条规则各写一句就串成「思考 → 调用 → 再思考 → 再调用」</small></span>
            <textarea class="text_pole textarea_compact" rows="2" data-field="preface" placeholder="先确认一下这一场涉及的既定设定。">${esc(rule.preface)}</textarea>
        </label>

        <div class="ctiu-grid">
            <label class="ctiu-field">
                <span>参数 Schema（JSON，工具声明用）</span>
                <textarea class="text_pole textarea_compact ctiu-mono" rows="6" data-field="schema" placeholder='{"type":"object","properties":{}}'>${esc(rule.schema)}</textarea>
            </label>
            <label class="ctiu-field">
                <span>调用参数 input（JSON，支持 {{宏}}）</span>
                <textarea class="text_pole textarea_compact ctiu-mono" rows="6" data-field="input" placeholder="{}">${esc(rule.input)}</textarea>
            </label>
        </div>

        <label class="ctiu-field">
            <span>工具结果 tool_result.content（纯文本，支持 {{宏}}）</span>
            <textarea class="text_pole textarea_compact" rows="8" data-field="result">${esc(rule.result)}</textarea>
        </label>

        <div class="ctiu-grid">
            <label class="ctiu-field">
                <span>插入位置</span>
                <select class="text_pole" data-field="posMode">${modeOptions}</select>
            </label>
            <label class="ctiu-field">
                <span>数值 / 偏移</span>
                <input type="number" class="text_pole" data-field="posValue" value="${esc(rule.posValue)}" step="1">
            </label>
        </div>

        <div class="ctiu-checks">
            <label class="checkbox_label">
                <input type="checkbox" data-field="declare" ${rule.declare ? 'checked' : ''}>
                <span>声明为可调用工具<small>（推荐开启；否则 useTools=false，注入内容会被降级成纯文本）</small></span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" data-field="stealth" ${rule.stealth ? 'checked' : ''}>
                <span>隐身工具<small>（模型真调用时结果不显示在聊天里，且不触发后续生成）</small></span>
            </label>
            <label class="checkbox_label" title="${isNative ? '' : '仅 native 注入格式支持 is_error'}">
                <input type="checkbox" data-field="isError" ${rule.isError ? 'checked' : ''} ${isNative ? '' : 'disabled'}>
                <span>标记为失败结果 <code>is_error: true</code>${isNative ? '' : '<small>（需切换到 native 注入格式）</small>'}</span>
            </label>
        </div>

        <div class="ctiu-field">
            <span>tool_use.id <small>固定值，改动会让注入点之后的 prompt cache 全部失效</small></span>
            <div class="ctiu-inline">
                <input type="text" class="text_pole ctiu-mono" data-field="callId" value="${esc(rule.callId)}">
                <div class="menu_button" data-act="regen-id">重新生成</div>
            </div>
        </div>

        <pre class="ctiu-preview" style="display:none"></pre>
    </div>
</div>`;
}

function renderRules() {
    const rules = getSettings().rules;
    const html = rules.length
        ? rules.map(renderRule).join('')
        : '<div class="ctiu-empty">还没有规则。点下面的「＋ 读取世界书模板」快速开始。</div>';
    $('#ctiu_rules').html(html);
    renderStatus();
}

function renderAll() {
    const settings = getSettings();
    $('#ctiu_enabled').prop('checked', settings.enabled);
    $('#ctiu_skip_dryrun').prop('checked', settings.skipDryRun);
    $('#ctiu_debug').prop('checked', settings.debug);
    $('#ctiu_capture').prop('checked', settings.captureRequests);
    $('#ctiu_redact').prop('checked', settings.redactSecrets);
    $('#ctiu_ensure_tools').prop('checked', settings.ensureTools);
    $('#ctiu_sources').val(settings.sources);
    $('#ctiu_format').val(settings.injectFormat);
    $('#ctiu_stage').val(settings.injectStage);
    renderRules();
    renderSnapshotList();
}

const SETTINGS_HTML = `
<div class="claude-tool-inject-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Claude 工具调用注入</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="ctiu_status" class="ctiu-status"></div>

            <label class="checkbox_label">
                <input id="ctiu_enabled" type="checkbox">
                <span>启用注入</span>
            </label>

            <label class="ctiu-field">
                <span>注入格式</span>
                <select id="ctiu_format" class="text_pole">
                    <option value="st">st —— 走 ST 中间格式（推荐，Claude 与 OpenAI 兼容代理都能用）</option>
                    <option value="native">native —— 直接写原生 Claude block（支持 is_error，仅 Claude / Vertex 源）</option>
                </select>
            </label>

            <label class="ctiu-field">
                <span>注入时机 <small>用 noass / mergeEditor 等合并脚本时必须选「请求发出前」</small></span>
                <select id="ctiu_stage" class="text_pole">
                    <option value="request">请求发出前 —— 最后一道，任何前端脚本都改不到（推荐）</option>
                    <option value="prompt">CHAT_COMPLETION_PROMPT_READY —— 走正常管线，会被合并脚本改写</option>
                </select>
            </label>

            <label class="checkbox_label">
                <input id="ctiu_ensure_tools" type="checkbox">
                <span>自动补全 tools<small>（「请求发出前」专用：请求体里没有 tools 时补上本扩展的工具声明，防止工具块被降级成纯文本）</small></span>
            </label>

            <label class="ctiu-field">
                <span>限定 API 来源 <small>逗号分隔，留空 = 不限制</small></span>
                <input id="ctiu_sources" type="text" class="text_pole" placeholder="claude,vertexai,custom">
            </label>

            <label class="checkbox_label">
                <input id="ctiu_skip_dryrun" type="checkbox">
                <span>跳过 dryRun（token 试算）阶段<small>（仅「CHAT_COMPLETION_PROMPT_READY」时机有意义）</small></span>
            </label>
            <label class="checkbox_label">
                <input id="ctiu_debug" type="checkbox">
                <span>输出调试日志到控制台</span>
            </label>

            <hr class="sysHR">

            <div id="ctiu_rules" class="ctiu-rules"></div>

            <div class="ctiu-toolbar">
                <div id="ctiu_add_template" class="menu_button">＋ 读取世界书模板</div>
                <div id="ctiu_add" class="menu_button">＋ 空白规则</div>
                <div id="ctiu_export" class="menu_button">导出规则</div>
                <div id="ctiu_import" class="menu_button">导入规则</div>
                <div id="ctiu_refresh" class="menu_button">刷新状态</div>
            </div>

            <div id="ctiu_io" class="ctiu-field" style="display:none">
                <span>规则 JSON</span>
                <textarea id="ctiu_io_text" class="text_pole textarea_compact ctiu-mono" rows="8"></textarea>
                <div class="ctiu-inline">
                    <div id="ctiu_io_apply" class="menu_button">应用导入</div>
                    <div id="ctiu_io_close" class="menu_button">关闭</div>
                </div>
            </div>

            <hr class="sysHR">

            <div class="ctiu-section-title">请求检查器</div>

            <label class="checkbox_label">
                <input id="ctiu_capture" type="checkbox">
                <span>抓取发往后端的请求体<small>（只留在浏览器内存里，最近 ${MAX_SNAPSHOTS} 次）</small></span>
            </label>
            <label class="checkbox_label">
                <input id="ctiu_redact" type="checkbox">
                <span>隐藏密钥 / 代理地址等敏感字段<small>（分享截图前请务必保持开启）</small></span>
            </label>

            <label class="ctiu-field">
                <span>请求快照</span>
                <select id="ctiu_snapshot" class="text_pole"></select>
            </label>

            <div class="ctiu-toolbar">
                <div id="ctiu_view_map" class="menu_button">消息位置图</div>
                <div id="ctiu_view_st" class="menu_button">ST → 后端 请求体</div>
                <div id="ctiu_view_upstream" class="menu_button">预估上游请求体</div>
                <div id="ctiu_view_copy" class="menu_button">复制</div>
                <div id="ctiu_view_download" class="menu_button">下载 JSON</div>
                <div id="ctiu_view_hide" class="menu_button">收起</div>
            </div>

            <pre id="ctiu_inspect_out" class="ctiu-preview ctiu-inspect" style="display:none"></pre>
        </div>
    </div>
</div>`;

function bindGlobalHandlers() {
    $('#ctiu_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        save();
        syncToolRegistrations();
        renderStatus();
    });

    $('#ctiu_skip_dryrun').on('change', function () {
        getSettings().skipDryRun = $(this).prop('checked');
        save();
    });

    $('#ctiu_debug').on('change', function () {
        getSettings().debug = $(this).prop('checked');
        save();
    });

    $('#ctiu_capture').on('change', function () {
        getSettings().captureRequests = $(this).prop('checked');
        save();
    });

    $('#ctiu_redact').on('change', function () {
        getSettings().redactSecrets = $(this).prop('checked');
        save();
    });

    $('#ctiu_sources').on('input', function () {
        getSettings().sources = String($(this).val() ?? '');
        save();
        renderStatus();
    });

    $('#ctiu_format').on('change', function () {
        getSettings().injectFormat = String($(this).val() ?? 'st');
        save();
        renderRules();
    });

    $('#ctiu_stage').on('change', function () {
        getSettings().injectStage = String($(this).val() ?? 'request');
        save();
        renderStatus();
    });

    $('#ctiu_ensure_tools').on('change', function () {
        getSettings().ensureTools = $(this).prop('checked');
        save();
        renderStatus();
    });

    $('#ctiu_add').on('click', () => {
        getSettings().rules.push(normalizeRule({ label: '新规则', name: 'my_tool', input: '{}', result: '' }));
        save();
        syncToolRegistrations();
        renderRules();
    });

    $('#ctiu_add_template').on('click', () => {
        getSettings().rules.push(makeLorebookTemplate());
        save();
        syncToolRegistrations();
        renderRules();
    });

    $('#ctiu_refresh').on('click', renderStatus);

    $('#ctiu_export').on('click', () => {
        $('#ctiu_io_text').val(JSON.stringify(getSettings().rules, null, 2));
        $('#ctiu_io').show();
    });

    $('#ctiu_import').on('click', () => {
        $('#ctiu_io_text').val('');
        $('#ctiu_io').show();
    });

    $('#ctiu_io_close').on('click', () => $('#ctiu_io').hide());

    $('#ctiu_io_apply').on('click', () => {
        try {
            const parsed = JSON.parse(String($('#ctiu_io_text').val() ?? ''));
            if (!Array.isArray(parsed)) throw new Error('顶层必须是数组');
            getSettings().rules = parsed.map(rule => normalizeRule({ ...rule, id: rule.id || randomId(12) }));
            save();
            syncToolRegistrations();
            renderRules();
            $('#ctiu_io').hide();
            toastr.success(`已导入 ${parsed.length} 条规则`);
        } catch (error) {
            toastr.error(`导入失败：${error.message}`);
        }
    });

    $('#ctiu_view_map').on('click', () => showInspector('map'));
    $('#ctiu_view_st').on('click', () => showInspector('st'));
    $('#ctiu_view_upstream').on('click', () => showInspector('upstream'));
    $('#ctiu_view_hide').on('click', () => showInspector('hide'));
    $('#ctiu_view_copy').on('click', copyCurrentView);
    $('#ctiu_view_download').on('click', downloadCurrent);
}

function bindRuleHandlers() {
    const root = $('#ctiu_rules');

    root.on('click', '[data-act]', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const action = $(this).data('act');
        const card = $(this).closest('.ctiu-rule');
        const rule = findRule(card.data('id'));
        if (!rule) return;

        switch (action) {
            case 'toggle':
                rule.expanded = !rule.expanded;
                save();
                renderRules();
                break;
            case 'delete':
                if (!confirm(`删除规则「${rule.label}」？`)) return;
                getSettings().rules = getSettings().rules.filter(item => item.id !== rule.id);
                save();
                syncToolRegistrations();
                renderRules();
                break;
            case 'duplicate': {
                const copy = normalizeRule({
                    ...structuredClone(rule),
                    id: randomId(12),
                    callId: makeCallId(),
                    label: `${rule.label} (副本)`,
                    name: `${rule.name}_copy`.slice(0, 64),
                });
                getSettings().rules.push(copy);
                save();
                syncToolRegistrations();
                renderRules();
                break;
            }
            case 'regen-id':
                rule.callId = makeCallId();
                save();
                card.find('[data-field="callId"]').val(rule.callId);
                break;
            case 'preview': {
                const pre = card.find('.ctiu-preview');
                if (pre.is(':visible')) {
                    pre.hide();
                } else {
                    if (!rule.expanded) {
                        rule.expanded = true;
                        save();
                        renderRules();
                        // 重新渲染后重新取节点
                        $(`.ctiu-rule[data-id="${rule.id}"] .ctiu-preview`).text(previewJson(rule)).show();
                        return;
                    }
                    pre.text(previewJson(rule)).show();
                }
                break;
            }
        }
    });

    root.on('input change', '[data-field]', function () {
        const field = $(this).data('field');
        const card = $(this).closest('.ctiu-rule');
        const rule = findRule(card.data('id'));
        if (!rule) return;

        if (this.type === 'checkbox') {
            rule[field] = $(this).prop('checked');
        } else if (this.type === 'number') {
            rule[field] = Math.trunc(Number($(this).val()) || 0);
        } else {
            rule[field] = String($(this).val() ?? '');
        }

        // 轻量更新标题栏，避免整表重绘导致输入框失焦
        if (['label', 'name', 'posMode', 'posValue'].includes(field)) {
            card.find('.ctiu-rule-label').text(rule.label || '(未命名)');
            const valid = TOOL_NAME_RE.test(String(rule.name || ''));
            card.find('.ctiu-rule-title code').text(rule.name || '(无工具名)').toggleClass('ctiu-bad', !valid);
            card.find('[data-field="name"]').toggleClass('ctiu-input-bad', !valid);
            card.find('.ctiu-rule-pos').text(ruleSummary(rule));
        }

        save();
        if (['enabled', 'declare', 'name', 'description', 'schema', 'stealth', 'label'].includes(field)) {
            syncToolRegistrations();
        }
        renderStatus();
    });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

jQuery(async () => {
    try {
        const context = ctx();

        $('#extensions_settings').append(SETTINGS_HTML);
        bindGlobalHandlers();
        bindRuleHandlers();
        renderAll();
        syncToolRegistrations();
        installFetchHook();

        context.eventSource.on(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);

        // 切换 API / 预设后刷新状态显示
        for (const eventName of ['CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'SETTINGS_UPDATED']) {
            const type = context.eventTypes[eventName];
            if (type) context.eventSource.on(type, () => renderStatus());
        }

        console.log(LOG, '已加载');
    } catch (error) {
        console.error(LOG, '初始化失败：', error);
    }
});
