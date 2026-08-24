# Claude 工具调用注入 (st-claude-tool-inject)

一个 SillyTavern 第三方扩展：把**预设条目里写的标签**翻译成真正的 Claude `tool_use` / `tool_result` 记录。

你在预设里画出调用链的形状，把世界书、文风、SKILL、聊天历史直接圈进「工具返回」里；插件在请求发出前把它重建成合法的工具调用结构。模型收到的不是"请参考以下设定"，而是**它自己刚刚调用工具读到的结果**。

工具的**使用说明**（名称 / 描述 / 参数 Schema）保存在插件里，随 `tools` 声明进系统提示词，不占预设的位置。

> **2.0 是破坏性改版。** 1.x 的「插入位置」面板已移除，位置改由预设条目的位置决定。旧规则会自动迁移进「工具库」（名称 / 描述 / Schema / 结果→兜底结果），但**位置需要你到预设里用标签重新摆**。

---

## 长什么样

预设里（顺序就是最终的消息顺序）：

```
【AI Assistant】  <tool_calls>
                  <invoke name="read_info">{"name":"world_setting"}</invoke>
                  <invoke name="skills"></invoke>
                  </tool_calls>

【User】          <tool_result name="read_info">
【World Info】    ← 世界书条目
【文件列表】       ← 普通预设条目

【User】          <tool_result name="skills">
【文风】
【NSFW 直白】
【文件读写 SKILL】
【User】          </tool_result>

【AI Assistant】  资料和技能都到位了。再把工作区的全部文件读一遍。

【AI Assistant】  <tool_calls><invoke name="read_all_file"/></tool_calls>
【User】          <tool_result name="read_all_file">
【Chat History】  ← 聊天历史整段进来
【User】          </tool_result>

【User】          【输出要求】接着往下写。
```

发到 Claude 就是：

```jsonc
{
  "system": [{ "type": "text", "text": "你是一个小说协作写手。" }],
  "messages": [
    { "role": "user",      "content": [{ "type": "text", "text": "【角色卡·蕾娜】…" }] },
    { "role": "assistant", "content": [
        { "type": "tool_use", "id": "toolu_T58Q…", "name": "read_info", "input": { "name": "world_setting" } },
        { "type": "tool_use", "id": "toolu_9kSC…", "name": "skills",    "input": {} }
    ]},
    { "role": "user",      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_T58Q…", "content": "【世界书·雾港】…\n\n【文件列表】…" },
        { "type": "tool_result", "tool_use_id": "toolu_9kSC…", "content": "【文风】…\n\n【NSFW 直白】…" }
    ]},
    { "role": "assistant", "content": [
        { "type": "text", "text": "资料和技能都到位了。再把工作区的全部文件读一遍。" },
        { "type": "tool_use", "id": "toolu_4KEk…", "name": "read_all_file", "input": {} }
    ]},
    { "role": "user",      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_4KEk…",
          "content": "Human: 蕾娜推开门…\n\nAssistant: 我抬头看了她一眼…\n\nHuman: 她没接话…" },
        { "type": "text", "text": "【输出要求】接着往下写。" }
    ]}
  ],
  "tool_choice": { "type": "auto" },
  "tools": [ { "name": "read_info", "description": "Read a reference document…", "input_schema": { … } }, … ]
}
```

---

## 标签语法

### 调用块

```
<tool_calls>
<invoke name="工具名">参数</invoke>
<invoke name="另一个工具"/>
</tool_calls>
```

- **必须在同一个预设条目内闭合。** 跨条目的 `<tool_calls>` 不会被识别（会告警并当作普通文本）。
- 一个块里可以放多个 `<invoke>`，对应 Claude 的「一个 assistant turn 里并行发起多次调用」。
- 参数三种写法，按优先级：
  1. `<parameter name="path">/notes/a.md</parameter>` —— 可重复，拼成对象。
  2. JSON 对象：`{"name":"world_setting"}`。
  3. 裸文本：整段塞进工具的**「裸文本参数名」**（默认 `input`）。
  4. 留空 → `{}`。

#### 调用块前面可以直接写旁白

同一个条目里「正文 + 调用块」是**支持的写法**，不用单开条目：

```
用户热情地向我打招呼。让我来看看有关用户的记忆:
<tool_calls>
<invoke name="memory">{"command":"view","path":"/memories/user_profile.md"}</invoke>
</tool_calls>
```

插件会把它拆成「一条 assistant 文本 + 一条 assistant 工具调用」，ST 的同角色合并
（`prompt-converters.js:340`）再把两条拼回 `[text, tool_use]` —— 也就是 Claude 原生的
「先说一句再调用」的形状。

两条规则：

- **紧挨着调用块前面的那段文字一律归 assistant**，不管它原本是什么角色。因为 `tool_use`
  只能待在 assistant 消息里，旁白必须跟它同一边。想让某段文字留在 user 那边，就别把它
  贴在调用块正上方（用 `<tool_result>` 圈起来，或者中间隔一条别的条目）。
- noass 开着时整段对话会被压成一条消息，这段旁白会带着 `TGD: ` 之类的前缀。插件会认出
  这类前缀并摘掉，同时**只把最后一个前缀之后的内容**当旁白，前面的聊天历史原样留在 user 那边。

### 返回区间

```
<tool_result name="工具名">
   …任意多个预设条目，全都成为这次调用的返回内容…
</tool_result>
```

- **区间可以跨任意多个条目**，这是它和调用块最大的区别 —— 世界书、聊天历史都是被展开成一堆消息的，正好整段圈进来。
- **闭合标签可以省略**：遇到下一个 `<tool_result>` 或下一个 `<tool_calls>` 时自动收尾。上面例子里 `read_info` 区间就是被 `skills` 区间接上的。
- `name` 用于配对。配对顺序：**先按同名匹配，再按出现顺序补位**。同名匹配优先意味着你在预设里调整条目顺序不会静默错配。
- `<tool_result name="x" error>` → `is_error: true`（**仅 `native` 注入格式支持**）。
- 找不到区间时用工具库里的**兜底结果**顶上，并弹提示告诉你哪个工具缺了内容。

### 多角色区间怎么拼

一个区间里如果混了 User 和 AI Assistant 条目（典型：聊天历史），拼成返回内容时会标上说话人：

```
Human: 蕾娜推开门，把湿漉漉的外套挂在钩子上。

Assistant: 我抬头看了她一眼："钟楼今晚又敲了十三下。"

Human: 她没接话，只是把徽章放在了桌上。
```

前缀名可改（设置 → 标签与拼接）。区间里只有一种角色时不加任何前缀，直接用空行拼接。

### 标签名可改

`tool_calls` / `invoke` / `tool_result` / `parameter` 四个标签名都能在设置里改，怕和正文撞车就改成别的。

---

## 安装

**扩展管理器**：SillyTavern → 扩展面板（插头图标）→ `Install extension` → 填本仓库的 Git URL。

**手动**：把整个目录放到

```
public/scripts/extensions/third-party/st-claude-tool-inject/
```

刷新页面，设置项在「扩展」面板中的 **Claude 工具调用注入**。

---

## 快速上手

1. API 来源切到 **Claude**（或指向 Claude 端点的 custom）。
2. 打开扩展设置 → 点 **＋ 参考资料三件套**，会得到 `read_info` / `skills` / `read_all_file` 三个工具。
3. 点工具卡片上的 **复制图标**，会把可直接粘贴的标签片段复制到剪贴板。
4. 到预设里新建条目，把片段粘进去，再把要当成"读到的内容"的条目拖到区间中间。
5. 发一条消息，回到扩展设置 → **请求检查器 → 解析报告**，核对每个工具吃到了哪段内容、有没有告警。

---

## 现成的工具包

`examples/` 下有两份可以直接粘进「导入工具库」的 JSON：

| 文件 | 工具 | 用途 |
|---|---|---|
| `examples/tools-memory.json` | `memory`、`list_memories` | 长期记忆目录。开场先让模型「查一下这个用户是谁」。 |
| `examples/tools-workspace.json` | `list_workspace`、`read_docs`、`skill` | 工作区。先列目录看有什么，再取参考文档和写作 SKILL。 |

两份可以叠着用 —— **导入是追加，不会清掉已有的工具**。

### 导入是追加还是覆盖

导入面板有两个按钮：

- **追加导入**（常用）：同名工具**就地更新**，其余追加到工具库末尾，原有工具原样保留。
  同一份 JSON 重复导入不会出现两份重名工具（工具名在上游报文里必须唯一）。
- **覆盖导入**：整个工具库替换成这份 JSON，会先弹确认。

「＋ 参考资料三件套」走的也是追加逻辑，点两下不会多出三个重名工具。

### 工作区三件套怎么用

`list_workspace` → `read_docs` / `skill`，两步链：先让模型「看见」工作区里有什么，再去取。

```
[AI助手] 列目录
先看看这个项目的工作区里有什么。
<tool_calls>
<invoke name="list_workspace"/>
</tool_calls>

[用户] 目录内容      <tool_result name="list_workspace">
[用户] /workspace/
       ├── docs/     参考文档
       └── skills/   写作 SKILL
[用户] 收尾          </tool_result>          ← 这行不能省，见下

[AI助手] 取内容
有设定文档，也装了写作 SKILL。两样都拉出来。
<tool_calls>
<invoke name="read_docs">/workspace/docs/world.md</invoke>
<invoke name="skill">prose-style</invoke>
</tool_calls>
...
```

⚠️ **两步链里，第一个区间必须显式写 `</tool_result>`。** 区间没闭合就会一路吃到下一个
`<tool_calls>`，把中间那句「有设定文档，也装了写作 SKILL」当成返回内容吞掉。

`list_workspace` 的**兜底结果**里已经预置了一份「docs/ + skills/」的目录树，所以你也可以
不写区间，只放调用块 —— 插件会自动用兜底结果填上：

```json
{"type":"tool_result","tool_use_id":"toolu_…","content":"/workspace/
├── docs/     参考文档 —— 世界观、角色、时间线、术语，本项目已经定稿的设定
└── skills/   写作 SKILL —— 行文规范、尺度政策、格式要求，动笔前需要载入"}
```

这种写法每次请求都会弹一条「用了兜底结果」的提示，嫌吵就关掉设置里的**「解析出问题时弹提示」**。

### `read_docs` / `skill` 怎么用

```
[AI助手] 资料调用
记起来了。动笔前把这次要用到的设定和写作规范拉出来。
<tool_calls>
<invoke name="read_docs">/workspace/docs/world.md</invoke>
<invoke name="read_docs">/workspace/docs/characters.md</invoke>
<invoke name="skill">prose-style</invoke>
</tool_calls>

[用户] 世界书       <tool_result name="read_docs">
[用户] （世界书条目，随便多少条）
[用户] 角色设定      <tool_result name="read_docs">
[用户] （角色卡）
[用户] SKILL 正文    <tool_result name="skill">
[用户] （SKILL.md 全文）
[用户] 收尾          </tool_result>
```

两个 `read_docs` 是同一个工具名的并行调用，两个同名区间**按出现顺序**配对，第一个区间给
第一次调用。两个工具都设了「裸文本参数名」，所以 `<invoke name="skill">prose-style</invoke>`
这种直接写值的形式就够了，不用写 JSON。

SKILL 的返回内容建议连 YAML frontmatter 一起放，模型对这个形状有很强的先验：

```
---
name: prose-style
description: 这个项目的行文规范，动笔前必读
---

# 行文规范
- 短句为主，一段不超过四行。
- 禁止总结式收尾，场景结束就停。
```

---

## 与 noass / mergeEditor 的关系

**不冲突，两种状态都能用。** 这正是改用文本标签的原因：合并脚本会把 `tool_calls` / `tool_call_id` 这些结构化字段丢掉，但它动不了文本里的标签。

插件默认在 **`请求发出前`** 工作，位置在合并脚本之后：

```
CHAT_COMPLETION_PROMPT_READY
        ↓
CHAT_COMPLETION_SETTINGS_READY  ← noass / mergeEditor 在这里工作   openai.js:3052
        ↓
fetch('/api/backends/chat-completions/generate')  ← 插件在这里解析标签   openai.js:3055
```

- **noass 关闭**：每个预设条目是一条消息，区间跨多条消息，按上面的规则拼接。
- **noass 开启**：整个预设被压成一两条带 `Sophia: ` / `Gray: ` 前缀的大文本，标签还在原地。插件在这条大文本内部按标签切分，效果一样。
  - 被标签切剩下的孤立角色前缀（例如区间开头单独一行 `Sophia:`）会被清掉 —— 设置里的**「清理残留的角色前缀」**。
  - 区间**内部**的 `Sophia: ` / `Gray: ` 前缀保留不动。对聊天历史区间这正是需要的（要靠它区分谁说的）；对世界书区间它只是多了一点 noass 自带的格式噪声。

配套的 **「自动并入 tools」**（默认开启）解决第二个坑：合并脚本工作时请求体里可能压根没有 `tools`，服务端就会走降级分支把工具块压成纯文本。开启后插件会把本次 `invoke` 到的工具声明并进去（已有的同名声明不会重复添加），并按设置写 `tool_choice`。

---

## 注意事项（重要）

1. **必须让请求体里有 `tools`，否则整条链会被降级成纯文本。**
   服务端的判断是 `useTools = Array.isArray(body.tools) && body.tools.length > 0`（`src/endpoints/backends/chat-completions.js:160`）。为 `false` 时 `convertClaudeMessages()` 会把所有 `tool_use` / `tool_result` **改写成 `text` 块** —— 内容还在，但不再是工具调用记录。保持「自动并入 tools」开启即可，状态面板会直接告诉你当前是否安全。

2. **`tool_choice` 的取舍。**
   - `auto`（默认）：模型看完伪造的调用记录后，还可以真的再发起一次调用。
   - `none`：只认历史记录，不许再调。Claude 的工具系统提示词会从 406 token 降到 286 token（Opus 5 实测）。
   若某个工具你希望模型真调用时也有反应，就把它设为**常驻声明** —— 插件会通过 `registerFunctionTool()` 注册它，真被调用时返回该工具的兜底结果。

3. **第一条非 system 消息不能是 assistant。**
   剥掉前导 system 之后，Claude 要求 `messages[0]` 是 `user`。如果你的调用块是预设里第一个非 system 的条目，会 400。解析报告会明确告警 —— 在调用链之前留一条 User 条目（角色卡、破限、开场白都行）。

4. **最后一条不能是 assistant。**
   数组末尾的 assistant 会被当成 prefill，Fable 5 / Opus 5 / Sonnet 5 / Opus 4.6+ / Sonnet 4.6 一律返回 400。让预设最后落在返回区间上，或在后面补一条 User 条目。解析报告同样会告警。

5. **`tool_use.id` 是内容决定的，不是随机的。**
   id 由 `工具名 + 参数 + 第几组 + 组内第几个` 哈希得到。只要预设没改，每次请求得到的 id 完全一致，注入点之后的 prompt cache 前缀不会失效。

6. **工具名必须匹配 `^[a-zA-Z0-9_-]{1,64}$`。** Claude API 的硬性约束，不匹配的 `<invoke>` 会被跳过并告警。

7. **注入内容不计入 ST 的 token 预算。**
   区间内容本来就是预设条目，算过了；但插件补进去的 `tools` 声明（每个工具的描述 + Schema）没算。写太长的描述会挤占上下文。

8. **`is_error` 只有 `native` 格式支持。** ST 的 `role:'tool'` 中间格式没有承载失败标记的字段。

9. **「预估上游请求体」是近似值。** `tool_use` / `tool_result` 转换、同角色合并、`useTools` 降级这几条与 ST 源码一致；`system` 提取、name 前缀、图片 base64、prefill 等细节做了简化。想要 100% 准确的报文请在反代侧开请求日志。

10. **角色前缀的识别是靠出现次数的。** noass 的 `Gray: ` 前缀在全文里会出现几十次，插件按
    「同一个名字出现 ≥ 3 次」或「纯 ASCII 短标签」判定它是前缀，才敢摘掉。所以你自己写的
    「让我看看记忆:」这种以冒号结尾的正文不会被误删。副作用：如果角色名是中文、整段对话里
    又只出现过一两次，那个前缀就摘不掉，会原样留在正文里 —— 关掉「清理角色前缀」也是一样的效果。

11. **请求检查器只在浏览器内存里保留快照**（最近 8 次），不写盘、不上传，刷新页面即清空。默认开启敏感字段打码（API Key、反代地址等），截图分享前请保持开启。

---

## 请求检查器

- **解析报告** —— 每一组调用吃到了哪个区间、多少字、走的是区间还是兜底、生成的 `tool_use.id`；下面是重建后的完整消息列表（`★` 标出工具块）；有问题时列出全部告警。
- **ST → 后端 请求体** —— 真实抓取的、发往 `/api/backends/chat-completions/generate` 的请求体。
- **预估上游请求体** —— 按 `convertClaudeMessages()` 规则本地复现的 Claude Messages API 请求体。
- 支持复制、下载 JSON。

---

## 兼容性

- SillyTavern：`staging` / `release` 近期版本（依赖 `SillyTavern.getContext()` 与 `ToolManager`）。
- API 来源：`claude`、`vertexai`，以及指向 Claude 格式端点的 `custom`。
  `st` 注入格式对 OpenAI 兼容端点同样有效（以标准的 `tool_calls` / `role:"tool"` 形式发出）。

---

## 许可

MIT
