# Claude 工具调用注入 (st-claude-tool-inject)

一个 SillyTavern 第三方扩展：在发往 **Claude 格式 API 端点**的对话记录里，于你指定的位置插入伪造的 `tool_use` / `tool_result` 记录，工具名、参数、结果全部可自定义。

典型用法：插入一条 `read_lorebook` 的「调用 + 结果」，让模型收到对话记录时认为自己**已经查过世界书**，并把结果当作既成事实来用 —— 比在系统提示词里干写一段"请参考以下设定"更容易被遵守。

附带一个**请求检查器**，可以看到实际发出的请求体和每条注入记录落在了第几条消息。

---

## 功能

- **两种注入时机**：默认在**请求真正发出前**改写请求体，排在所有前端脚本之后，`noass` / `mergeEditor` 这类合并脚本改不到（详见"与合并类脚本的冲突"）。
- **任意位置注入**：深度（倒数第 N 条）/ 绝对索引 / 最后一条 user 之前 / 最后一条 user 之后，均可再加偏移。
- **多条规则**：每条规则独立开关、独立位置，支持复制、导入 / 导出 JSON。
- **完全自定义**：工具名、工具描述、参数 JSON Schema、调用参数 `input`、返回结果 `content`。参数与结果支持 `{{char}}` `{{user}}` 等 ST 宏。
- **两种注入格式**
  - `st`（默认）：写入 ST 的中间格式（`assistant.tool_calls` + `role:'tool'`），由 ST 服务端的 `convertClaudeMessages()` 转成 Claude 块。兼容性最好，OpenAI 兼容代理也能用。
  - `native`：直接写入原生 Claude 内容块。**只有这个模式支持 `is_error: true`**（ST 的中间格式没有表达失败结果的字段）。仅适用于 Claude / Vertex 源。
- **自动声明工具**：每条规则默认同时通过 `ToolManager.registerFunctionTool()` 注册为真实工具，避免请求体里没有 `tools` 导致注入内容被降级（见下方"注意事项"）。模型若真的调用该工具，返回的仍是你预设的那份结果。
- **状态面板**：实时显示当前 API 来源、函数调用开关、已注册工具数，并在会被降级时给出红色警告。
- **请求检查器**
  - `消息位置图` —— 注入前后消息数、每条注入落在的下标、整条消息列表（`★` 标出注入项）。
  - `ST → 后端 请求体` —— 真实抓取的、前端发往 SillyTavern 后端 `/api/backends/chat-completions/generate` 的请求体。
  - `预估上游请求体` —— 按 `convertClaudeMessages()` 的规则本地复现出的 Claude Messages API 请求体（近似，见下）。
  - 支持复制到剪贴板、下载成 JSON、保留最近 8 次快照。
  - 默认开启**敏感字段打码**（API Key、代理密码、反代地址等），截图分享前请保持开启。

---

## 安装

**方式一：扩展管理器**

SillyTavern → 扩展面板（插头图标）→ `Install extension` → 填入本仓库的 Git URL。

**方式二：手动**

把整个目录放到 SillyTavern 的：

```
public/scripts/extensions/third-party/st-claude-tool-inject/
```

然后刷新页面。设置项在「扩展」面板中的 **Claude 工具调用注入**。

---

## 快速上手

1. 在「AI 回复设置」里把 API 来源切到 **Claude**（或你的自定义 Claude 端点），并勾选 **Enable function calling**。
2. 打开扩展设置，点 **＋ 读取世界书模板**。
3. 把「工具结果」改成你希望模型"以为自己刚查到"的内容。
4. 位置保持默认（深度 0 = 插在对话最末尾），或按需调整。
5. 点规则卡片上的 👁 预览，确认生成的 JSON 结构符合预期。
6. 发一条消息，然后在「请求检查器」里点 **消息位置图** 核对注入位置。

---

## 与合并类脚本的冲突（noass / mergeEditor 等）

如果你在用把整段对话压成单条消息的脚本（俗称 noass、"合并配置"、mergeEditor 等），**默认设置已经处理好了**；下面是原因，遇到问题时可以照着排查。

### 冲突是怎么发生的

这类脚本挂在 `CHAT_COMPLETION_SETTINGS_READY` 上（通常还用 `eventMakeLast` 把自己排到最后），而 SillyTavern 的事件顺序是：

```
CHAT_COMPLETION_PROMPT_READY   ← 本扩展原来的注入点
        ↓
CHAT_COMPLETION_SETTINGS_READY ← 合并脚本在这里工作     openai.js:3052
        ↓
fetch('/api/backends/chat-completions/generate')        openai.js:3055
```

它们的处理逻辑是：不带 `<|no-trans|>` 标记的消息全部丢进一个 merge block，最后用
`{ role: merge_target_role, content: 拼接出来的大字符串 }` 替换掉 —— **`tool_calls` 和 `tool_call_id` 这两个字段被直接丢弃**。

更麻烦的是，加 `<|no-trans|>` 标记也救不了：走"保留"分支时它同样只重建 `{ role, content, name }`，工具字段照样没了；而我们注入的 assistant 消息 `content` 是空串，标记被剥掉后内容为空，整条消息会被跳过。

结果就是一次工具调用退化成两段普通文本：

```js
{ role: 'assistant', content: [ { type: 'text', text: '收到任务，让我先查看一下当前的故事有关设定：' } ] },
{ role: 'user',      content: [ { type: 'text', text: 'tool: Readed.\n\n请继续构思剧情' } ] }
```

### 解决办法

把**注入时机**设为 **`请求发出前`**（v1.2.0 起是默认值）。此时注入发生在 `fetch` 的 body 序列化之前、`CHAT_COMPLETION_SETTINGS_READY` 之后，合并脚本已经跑完，插进去的消息不会再被任何前端脚本碰到。

配套的 **`自动补全 tools`**（默认开启）解决第二个坑：合并脚本工作时请求体里可能压根没有 `tools`，服务端就会走降级分支把工具块压成文本。开启后，扩展会在发出前补上自己的工具声明（并把 `tool_choice` 置为 `auto` —— 服务端会写成 `{ type: request.body.tool_choice }`，留空会发出非法的 `{ type: undefined }`）。

### 副作用与取舍

- 位置是按**合并之后**的消息数组解析的。合并脚本通常只剩 2～3 条消息，所以 `深度 0`（插在最后）基本就是你要的效果；具体落点用「请求检查器 → 消息位置图」看，那里显示的就是最终数组。
- 注入内容对其它扩展不可见（它们的钩子都在更早的位置）。需要让别的脚本也能处理这两条消息时，才改回 `CHAT_COMPLETION_PROMPT_READY`。
- 如果合并脚本把整块内容变成了 `role: 'assistant'`，我们注入的 assistant（`tool_use`）会和它合并成同一个 assistant turn，`tool_use` 落在该 turn 末尾 —— 这是合法的 Claude 结构，不影响使用。

---

## 注意事项（重要）

1. **必须开启函数调用，否则会被降级。**（用「请求发出前」+「自动补全 tools」时此项可不管）
   SillyTavern 服务端的判断是 `useTools = Array.isArray(body.tools) && body.tools.length > 0`。
   当 `useTools` 为 `false` 时，`convertClaudeMessages()` 会把所有 `tool_use` / `tool_result` 块**改写成纯 `text` 块** —— 注入还在，但不再是工具调用记录了。
   所以请保持「声明为可调用工具」开启，并在 ST 里勾选 `Enable function calling`。状态面板会直接告诉你当前是否安全。

2. **以下情况 ST 不会注册工具**，因此同样会触发降级（`自动补全 tools` 可以兜住）：
   - 开启了多轮 swipe（multi-swipe）；
   - 生成类型为 `impersonate` / `quiet` / `continue`；
   - `custom_prompt_post_processing` 不在 none / merge_tools / semi_tools / strict_tools 之列。

3. **注入内容不计入 ST 的 token 预算。**
   注入发生在 `CHAT_COMPLETION_PROMPT_READY`，此时预算已经算完了。结果写太长可能把上下文顶爆，请自行控制长度。

4. **`tool_use.id` 是固定值，不要频繁改。**
   每条规则的 `callId` 存在设置里、跨请求保持不变。如果每次随机生成，注入点之后的所有内容都会成为新前缀，**prompt cache 全部失效**。界面上提供了手动重新生成按钮，仅在需要时使用。

5. **工具名必须匹配 `^[a-zA-Z0-9_-]{1,64}$`。**
   这是 Claude API 的硬性约束。不匹配的规则会被跳过并在控制台告警，界面上该字段会标红。

6. **注入位置有下限保护。**
   扩展会计算「第一条非 system 消息的下标 + 1」作为最小可插入位置。否则剥掉前导 system 之后，注入的 `assistant` 会变成 `messages[0]`，Claude 会直接返回 400。位置图里会标注被上推的情况。

7. **`is_error` 只有 `native` 模式支持。**
   ST 的 `role:'tool'` 中间格式没有承载失败标记的字段，转换时也不会产出 `is_error`。需要伪造"工具调用失败"的记录时请切到 `native`。

8. **「预估上游请求体」是近似值。**
   `tool_use` / `tool_result` 转换、同角色消息合并、`useTools` 降级这几条与 ST 源码一致；`system` 提取、name 前缀、图片 base64、prefill 等细节做了简化。想要 100% 准确的上游报文，请在你的反向代理 / 中转服务侧开请求日志。

9. **请求检查器只在浏览器内存里保留快照**，不写盘、不上传，刷新页面即清空。

---

## 兼容性

- SillyTavern：`staging` / `release` 近期版本（依赖 `SillyTavern.getContext()`、`CHAT_COMPLETION_PROMPT_READY` 事件与 `ToolManager`）。
- API 来源：`claude`、`vertexai`，以及指向 Claude 格式端点的 `custom`。
  `st` 注入格式对 OpenAI 兼容端点同样有效（会以标准的 `tool_calls` / `role:"tool"` 形式发出）。

---

## 许可

MIT
