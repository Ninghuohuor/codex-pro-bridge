# Codex Pro Bridge — 技术规格

实现说明（2026-09-25）：下文保留最初 V0 设计基线。真实网页首选执行路径已按 [ADR 0001](ADR-0001-agent-browser.md) 改为 Codex Computer Use 操作用户已登录的 Chrome；独立 Playwright Profile 仅保留为实验路径。任务、授权与去重仍由本地运行器负责。

## 5. 总体架构

```text
用户
  ↓
本地 Codex（主模型继续承担执行与工具编排）
  │ stdio MCP
  ▼
Codex Pro Bridge：MCP 入口进程
  │ 经过鉴权的本机 IPC
  ▼
Codex Pro Bridge：单实例本地运行器
  ├─ 任务队列与恢复
  ├─ SQLite 状态与不可变快照
  ├─ 授权与内容扫描
  └─ 浏览器适配器
          ↓ Playwright
     独立 Chrome / Edge Profile
          ↓ 网页交互
     已登录的 ChatGPT 网页
```

这是一个软件包中的两个进程，不是需要用户部署的两套服务。MCP 入口随 Codex 启停；运行器负责持有浏览器和长任务，避免一次工具调用超时就丢失工作。

**本产品中的 MCP 方向是 Codex → 本地桥。**它不需要把本地项目作为远程 MCP 暴露给网页 ChatGPT。参考项目 yichen 的“ChatGPT 读取本地证据”是另一条反向连接，不是本产品的前置条件。[R1]

### 5.1 技术栈与约束

| 层 | 选择 | 约束 |
|---|---|---|
| 语言 | TypeScript，strict 模式 | 使用类型与运行时校验 |
| 运行时 | Node.js 24 LTS | 锁定实际验收的小版本；发布页目前列为 LTS。[O5] |
| MCP | 官方 TypeScript SDK | 使用已验证稳定版本及锁文件，不手写协议。[O3] |
| 浏览器 | `playwright-core` + 系统 Chrome/Edge | 指定独立 Profile；默认有窗口 |
| 状态 | SQLite | 单运行器写入，事务、迁移、完整性检查 |
| SQLite 访问 | Node 24 的 `node:sqlite`，封装在仓储层 | 官方 Node 24 文档已提供该模块，但不能据此声称所有 API 已稳定；锁定运行版本并在依赖决策中记载其成熟度。[O7] |
| 校验 | 与 SDK 兼容的 schema 库 | 版本在构建里锁定 |
| 测试 | Node 测试框架/等价轻量框架 + Playwright 测试夹具 | 不为测试强制接真实账户 |
| 分发 | 单 npm 软件包或受控源码安装 | V0 不额外开发 Electron/Tauri 桌面壳 |

SQLite 只处理有大小上限的本地数据。禁止在浏览器关键路径执行长时间数据库整理。若锁定 Node 版本存在 SQLite 兼容阻塞，必须先记录 ADR 再更换驱动，不在不同机器上静默切换实现。

### 5.2 本机 IPC 的 V0 选择

为减少 Windows 命名管道 ACL 和跨平台原生依赖，V0 内部 IPC 使用 **仅绑定 `127.0.0.1` 的随机端口 HTTP**。这不是公网 MCP、不是对外模型 API，也不要求云服务器。对 Codex 的入口仍然是 stdio。

运行器启动时生成随机令牌和实例 nonce，写入当前用户私有状态目录；所有 IPC 请求必须携带令牌。拒绝非预期 Host、带浏览器 Origin 的请求和错误 Content-Type；不提供 CORS，不把令牌放 URL，不接受任意远程 endpoint 配置。不监听 `0.0.0.0` 或局域网地址。

MCP 入口与 CLI 使用同一鉴权客户端。浏览器网页不能仅凭猜测本机端口控制运行器。状态文件必须限制当前用户权限；令牌及端口不得混入发送给 ChatGPT 的内容。

这是一项相对旧方案的简化：旧方案建议每个平台独立实现 socket/pipe。后续可替换内部 IPC，而不改变五个 MCP 工具的契约。

## 6. 运行器、并发与生命周期

同一操作系统用户的默认 Profile 只有一个运行器拥有者。多个 Codex 项目的 MCP 入口可以连接该运行器，但网页任务按 Profile 全局串行。

| 参数 | V0 初始值 | 说明 |
|---|---|---|
| 网页活动任务数 | 1 | 从开始网页准备到结束/暂停处理期间独占 |
| 等待队列 | 最多 5 个 | 超出返回 QUEUE_FULL，不自动创建更多浏览器 |
| ask 本地返回目标 | 5 秒内 | 不包含上游生成；目标不是已测性能 |
| get_task 最大长轮询 | 20 秒 | 读取本地状态，不重新向网页发送问题 |
| 建议查询间隔 | 10 秒，后续可增加到 30 秒 | 返回 next_poll_after_ms，避免模型高频空转 |
| 单次网页观察预算 | 从点击发送起默认最长 10 分钟 | Pro 长时间思考或临时 WEB 地址不单独视为失败；预算结束后保留原任务并释放新任务队列，新请求另开标签，Codex 先回答且明确标注 Pro 未回复，不自动重发旧请求 |
| 空闲退出 | 无任务、无客户端连接 10 分钟 | 有未解决的提交状态时不得静默清理 |

以上均是本产品初始阈值，不是 ChatGPT 官方限制或真实响应时间预测。

运行器按需启动，不安装系统服务、不申请管理员权限。使用原子启动锁、实例 nonce、PID 和启动信息防止竞争；失去所有权的旧实例必须停止网页动作。不能仅凭“心跳过期”抢占仍活着的实例。

出现崩溃、休眠、系统重启或宿主清理子进程，持久任务仍可恢复到待核对状态；**不承诺操作系统级永不间断**。Windows 上进程脱离宿主后的行为必须实测；即使无法保证继续运行，也必须保证记录不被误删、未知提交不被重发。

若正在生成或提交状态未知，V0 不让下一个任务抢用同一标签。只有已显示本次完整用户消息、观察超过预算并记为 `OBSERVATION_TIMEOUT` 的暂停任务不再阻塞全局队列；其原标签和去重记录保留，新任务另开标签。其他未知发送仍阻塞队列。等待外发审批的任务不占网页执行锁。

## 7. 五个 MCP 工具契约

统一使用显式 `project_id`、`task_id`、`session_id`，不依赖当前标签页、隐式连接上下文或模型对话记忆。MCP 工具返回结构化数据，并提供兼容的文本表示；软件返回结构化数据不等于强制网页模型输出 JSON。[O6]

每个工具都必须有 input/output schema、最大输入/输出限制、脱敏错误、必要的副作用注释。不要把工具 annotations 当成权限控制。[O6]

| 工具 | 输入核心字段 | 返回核心字段 |
|---|---|---|
| `codex_pro_status` | `live=false` | 绑定项目、运行器版本、缓存或实时状态、采样时间、当前限制 |
| `codex_pro_prepare_context` | `project_id`、明确的文件片段、diff 模式、可选 notes | 不可变 packet_id、manifest、hash、扫描结果、预览 |
| `codex_pro_ask` | `project_id`、request_key、question、mode、packet_id、session | task_id、状态、是否需确认、next_poll_after_ms |
| `codex_pro_get_task` | `project_id`、task_id、wait_ms、可选 cursor | 状态、交付证据、回答分页、恢复建议 |
| `codex_pro_cancel` | `project_id`、task_id | 取消请求状态、上游是否确认停止 |

### 7.1 status

默认仅读取本地状态，报告 `observed_at` 与 `stale`。过期缓存不能直接显示“当前已登录且 Pro 可用”。返回本 MCP 入口绑定的项目，不列出用户的所有项目/聊天。

`live=true` 只在浏览器空闲时执行页面就绪检查；有活动任务时返回 BUSY 或缓存，不能切页破坏任务。不发送任何健康检查 prompt，不问“你是什么模型”。

状态与错误中不返回邮箱、Cookie、认证头、完整个人聊天标题。

### 7.2 prepare_context

示例为拟定输入，不是现成可调用工具：

```json
{
  "project_id": "prj_example",
  "files": [
    {"path": "src/ExperienceService.swift", "start_line": 1, "end_line": 180},
    {"path": "tests/ExperienceServiceTests.swift"}
  ],
  "diff": "both",
  "notes": "关注重复签到与跨日边界；日志已人工脱敏。"
}
```

`files` 必须是注册项目内的明确相对路径，不接受 glob 或目录递归打包。start/end 都省略表示读取整个合规小文件；同时提供时必须为有效范围。`diff` 为 `none | staged | unstaged | both`，仅针对明确文件；非 Git 项目只接受 none。

输出包括 `packet_id`、`packet_sha256`、`manifest`、`total_bytes`、`scan_status`、`snapshot_revision` 和人工预览位置。manifest 中只使用相对路径。任何被拦截的文件必须明确说明，不能静默删掉后宣称“完整项目已发送”。

prepare 只在本机产生快照，不发送给网页。但工具的预览结果会进入 Codex 上下文，因此预览也不得包含已识别秘密。不向模型返回被拦截的秘密原文。

### 7.3 ask

```json
{
  "project_id": "prj_example",
  "request_key": "req_example_001",
  "mode": "review",
  "question": "审查这次经验值计算修改，重点检查重复发奖和跨日问题。",
  "context_packet_id": "pkt_example",
  "session": {"kind": "new"}
}
```

继续追问时 session 改为 `{"kind":"continue","session_id":"ses_example"}`。mode 仅 `ask | plan | review | debug`。context_packet_id 可省略，以支持不附代码的纯文本咨询；question 和模板仍必须经过扫描和授权检查。

网页 route 来自用户本地配置，不开放 MCP 参数让模型任意选择其他模型、账户或网站。配置变化会使相关未发送任务重新检查。

ask 的职责是冻结本次完整外发消息、验证归属与去重、创建持久任务。它不在一个调用里等 Pro 生成完成。

```json
{
  "task_id": "tsk_example",
  "status": "awaiting_approval",
  "delivery": "not_sent",
  "approval_required": true,
  "payload_sha256": "example_hash_not_a_real_digest",
  "next_action": "请用户在本地查看并批准这份完整外发内容。"
}
```

命中有效的限时授权时，可直接返回 queued。外发是有副作用的行为，不能标记为 readOnly。是否完成审批不能由模型自己传 `confirmed=true` 决定。

### 7.4 get_task

`wait_ms` 为 0–20000；cursor 用于不可变结果的分页。get_task 只读本地数据库/结果，不发送、重发或催促上游；客户端超时也不删除任务。

```json
{
  "task_id": "tsk_example",
  "status": "completed",
  "delivery": "confirmed_sent",
  "session_id": "ses_example",
  "route": {
    "requested_display": "Pro",
    "selected_before": "Pro",
    "selected_after": "Pro",
    "ui_selection_verified": true,
    "backend_model_verified": false
  },
  "answer": {
    "completeness": "complete",
    "association_verified": true,
    "format": "markdown",
    "text": "这里是本次网页回答的原文片段。",
    "next_cursor": null,
    "response_sha256": "example_response_hash"
  },
  "warnings": []
}
```

session URL 可以返回给同项目的用户检查，但不写进默认诊断日志或公开报告。不得声称 `backend_model_verified=true`，即使模型自称某个版本。

每页建议最多 12 KiB 的回答文本，序列化后的整个 MCP 返回控制在 32 KiB 内；超长内容生成稳定 cursor。cursor 必须绑定 task、结果 hash 和项目，不能作为任意文件路径使用。不拆坏 UTF-8 字符；分页拼接必须恢复同一份原文。

部分内容、未知关联、过期内容要分别返回 `partial`、`unverified`、`RESULT_EXPIRED`，不能统称成功。

### 7.5 cancel

未发送任务可以真正停止本地调度；已提交任务只能在已绑定页面上请求点击停止，并核验可见结果。返回 `upstream_stop` 为 `not_needed | confirmed | unconfirmed`。

上游停止未确认时不能谎报 cancelled，应保留 `cancel_requested` 标记和暂停状态。已发送内容不能借取消撤回，停止也不意味着额度退款。对已完成任务取消返回 already_completed，不删除答案。

### 7.6 协议与客户端兼容

Codex 官方支持本地 stdio、服务器 instructions 和工具配置；当前文档列出的默认单工具超时是 60 秒。本设计采用短调用+任务号，避免把长网页生成绑在单次 MCP 连接上。[O1]

MCP 的不同版本由锁定 SDK 负责协商或选择；不要把不同协议版本的原始 JSON 混合手写。V0 不依赖客户端一定支持原生 Tasks 扩展：task_id 是本产品的应用层状态句柄。只有经过实测的 SDK/Codex 组合可列为兼容。

## 8. 数据与事务

V0 使用一个本地数据库，由运行器负责所有业务写入；CLI 和 MCP 入口通过 IPC 调用，不直接竞争修改业务表。启用外键，迁移带版本号，发布前测试升级与备份恢复。

| 表 | 主要字段 |
|---|---|
| projects | id、canonical_root、root_identity、workspace_epoch、允许路径、创建时间 |
| profiles | id、专用目录、browser_channel、login_epoch、route_config、验证时间 |
| sessions | id、project_id、workspace_epoch、profile_id、login_epoch、conversation_url、route_fingerprint、状态 |
| context_packets | id、project_id、manifest_json、内容快照、内容 hash、Git/文件版本、创建与过期时间 |
| grants | id、类型、project/profile/login_epoch、范围、payload_hash 或路径白名单、剩余次数、有效期 |
| tasks | id、project_id、request_key、payload_hash、完整外发快照、session_id、status/phase/delivery、授权引用、时间、取消标记 |
| task_results | task_id、Markdown 原文、结果 hash、完整性/关联/路线证据、可选格式警告 |
| task_events | task_id、状态迁移、原因码、时间、运行器实例；不重复正文 |
| request_tombstones | project_id、request_key、payload_hash、原 task_id、最终摘要状态、过期时间 |

### 不可破坏的约束

`(project_id, request_key)` 在有效去重窗口内唯一。session、packet、grant 必须与 task 属于同一个项目及允许的 profile/login_epoch。任务创建、去重检查和关联写入应在同一事务中完成。

同 key + 同 payload：返回原任务，不新建也不重新发送；同 key + 不同 payload：返回 IDEMPOTENCY_CONFLICT。内容 hash 包含 question、模板版本、packet hash、route 指纹和 session 选择。

新建 session 的本地预留 ID 在首次任务创建时固定；重试不得重新生成该 ID。继续对话要求 session 可用且无本产品尚未结束的请求。

在触发网页发送前，先持久提交 `phase=submit, delivery=maybe_sent` 和本次请求标记；观察到对应新用户消息后，才写入 confirmed_sent。该“发送意图”事务采用足够的持久化设置并做崩溃注入测试，但不得承诺所有硬件故障下绝对不丢数据。

授权次数在即将发送时以事务预留；提交结果未知也保留计数，不因重连返还次数。确定未进入发送步骤才可释放预留。账本记录的是本软件的发送预算，不是假装读取 ChatGPT 官方额度。

## 9. 任务状态机与恢复

不要用一个状态字符串同时表示登录、传输和回答质量。采用正交字段：

| 字段 | 值 |
|---|---|
| status | awaiting_approval / queued / running / paused / completed / failed / cancelled |
| phase | preflight / compose / submit / wait / capture / reconcile |
| delivery | not_sent / maybe_sent / confirmed_sent |
| pause_reason | 具体错误码或 null |
| cancel_requested | boolean |
| answer_completeness | none / partial / complete |

正常流程为 awaiting_approval → queued → running → completed。有有效授权时跳过 awaiting_approval。

completed 必须同时满足：本次发送已确认、本次回答关联明确、网页完成信号成立、发送前后 route 检查通过、结果已落盘。若回答已完整捕获但 route 改变，保留原文并暂停，明确它不是已经验证的 Pro 成功结果。

### 9.1 三类恢复

**确定未发送：**登录失败、模型选项缺失、预览未批准等。修正后由用户 resume；原 payload 不变时仍用同一个 task，不能自动改模型或内容。

**可能已发送：**点击发送前后的连接/进程崩溃。进入 DELIVERY_UNKNOWN，先核对原页面、原 conversation 和请求标记；不再执行发送动作。

**确定已发送：**生成等待、提取或本地连接失败。只恢复观察/读取；找到同一回答就保存，找不到就继续明确报未知，而不是重发。

网页没有接受本软件幂等键的官方契约，因此只能提供本地去重和保守恢复，不能声称服务端 exactly-once。

### 9.2 新对话的特殊不确定性

网页可能在发送第一条消息后才分配对话 URL。发送前在批准的消息中加入可见、无秘密的请求标记，例如 `[CPB request: <task_id>]`。标记不代表后台消息 ID，只用于关联证据。

运行器监听本工具拥有页面的导航，并尽快持久保存 conversation URL。若在 URL 保存前崩溃、原页面也无法重新识别，返回 DELIVERY_UNKNOWN，请用户检查；不能靠“最近一条聊天大概是它”猜测成功。

必要时 CLI 允许用户显式绑定一个会话 URL用于核对，必须校验官方来源、项目、请求标记与消息边界。V0 不批量扫描历史来寻找它。

### 9.3 恢复入口

`get_task` 不触发有副作用的恢复。用户通过 `tasks resume <id>` 明确允许重新检查；运行器根据 delivery 决定“可继续原未发送流程”或“只能核对已发送请求”。

收到暂停消息后的 Codex instructions 必须要求用户处理，不能通过新 request_key 绕过暂停。相同失败任务的重复调用仍返回原状态。

## 10. 网页适配器

### 10.1 独立 Profile

使用 `launchPersistentContext` 管理专用配置目录。Playwright 官方明确该目录保存 Cookie/local storage 等会话数据，不允许多个浏览器实例同时占用；并警告不要自动化日常 Chrome 默认 Profile。[O4]

所以准确表述是“软件不导出、不代管用户凭据”，不是“电脑上完全不保存 Cookie”。专用 Profile 属于敏感本地数据，不能进 Git、日志压缩包或教程附件。

默认有窗口。最小化可作为经过平台验证的选项；V0 不承诺 headless、绝不抢焦点或任意浏览器版本都能工作。不使用 stealth、反检测补丁、验证码代解或私有会话接口。

### 10.2 适配器接口

建议内部能力包括 `inspectReady`、`verifyRoute`、`openNewConversation`、`openBoundConversation`、`composeAndVerify`、`submitOnce`、`observeReply`、`captureReply`、`reconcileSubmission`、`requestStop`。它们不是额外暴露给 Codex 的 MCP 工具。

浏览器行为与状态机解耦；选择器集中管理，优先可访问性角色和语义属性，再使用经验证的稳定 DOM 属性。不能把整套网页逻辑写进 SKILL.md，也不能把固定屏幕坐标作为默认方案。

### 10.3 登录与 route

登录、验证码、账单和权限提示由用户处理。用户在 setup 中选择页面上实际可用的 Pro 选项，记录其模型标签、档位/强度标签、模式和 UI 语言，形成 route fingerprint。

每次发送前核验匹配；发送后再核验。无法识别选项时停止，不把“最高档位”“Latest”“非 mini”自动等同于 Pro，不靠问模型身份或抓取网络 model_slug 验证后台身份。

专用 Profile 只绑定一个账户/工作区。检测到登录、退出、工作区或可见账户状态改变时，增加 login_epoch、撤销旧 grant、暂停未发送任务。账户状态不能确认时停止，不默认沿用。可保存最小化的本地账户提示指纹，但不向模型返回邮箱。

### 10.4 提交步骤

只操作本运行器拥有的页面。先核验 origin、目标 conversation、无未授权草稿/附件、没有既有生成，再填写经批准的完整快照并核对文本。

持久化发送意图后，发送动作只执行一次。点击后未确认，不再追加 Enter“试试看”。任何人工切页、改草稿或插入消息都要识别为冲突，不能覆盖用户输入。

首次允许导航到官方 ChatGPT 来源；登录跳转只让用户处理。不接受外部网页提供的新 endpoint，不自动打开回复中的链接，不把模型回答中的文件路径当授权。

### 10.5 回答关联与完成判定

先记录本次用户消息标记/内容指纹和消息边界，再获取其后对应的新 assistant 回复。可以使用 DOM 提供的稳定消息标识，但不得依赖它一定存在。

禁止“读取整页最后一段文字”“读取 main 最后一段”“已有旧答案看起来符合格式就返回”等降级方式。关联不唯一就停止。

完成判断必须综合：本次新消息存在、已识别生成状态退出、已识别该回复的完成控件/信号、正文稳定、无错误/中断提示。仅文字几秒没变、仅 Stop 按钮没找到，都不足以证明完成。

页面 DOM 观察以事件方式为主，辅以有上限的状态检查；本地查询不能导致刷新网页。未知 UI 返回 UI_UNSUPPORTED，不调用另一个模型临时猜测点击位置。

## 11. 上下文、安全与隐私

### 11.1 内容包

内容包由项目说明、具体问题、明确选中的文件片段、对应 diff、可选已脱敏日志以及要求的输出形式组成。相关文件选择由 Codex 在用户任务范围内完成；Bridge 不另外调用 embedding 或其他模型来“智能检索”。

| 限制 | 初始值 |
|---|---|
| 明确文件/片段数量 | 最多 20 |
| 单文件或片段 | 最多 32 KiB UTF-8 |
| question | 最多 8 KiB UTF-8 |
| 最终完整外发消息 | 最多 128 KiB，包含模板、标记、diff 和 manifest |
| 回答持久保存上限 | 最多 2 MiB；超出明确标记不完整，不静默截断 |

这些是保护阈值，不是 token 额度或网页官方上限。字节数不能假装是精确 token 数。网页输入限制更小时应缩小范围并重新确认，不自动拆分为多次消耗额度的提问。

### 11.2 文件边界

根目录来自用户注册的项目，不接受模型临时提交任意绝对目录。路径做 canonical/realpath 检查，阻止 `..`、绝对路径、符号链接/junction 逃逸、设备文件和二进制。V0 对跨目录链接采取拒绝策略。

默认拒绝 .env 类文件、私钥、凭据文件、浏览器 Profile、Codex auth 数据及敏感客户数据；默认排除 node_modules、.git 和构建输出。普通 .gitignore 不是安全边界；密钥可能存在任何扩展名中，所以 question、notes、diff、文件和最终快照都要扫描。

Git 操作仅允许固定的本地只读状态/diff 命令，以参数数组执行，不拼接 shell。禁用外部 diff/textconv 等可能执行项目配置程序的能力；使用 literal pathspec，限定明确文件，不运行 hooks、fetch、安装、提交或推送。删除文件的 diff 也必须扫描和核对原路径边界。

快照一经形成即不可变。准备过程中发现文件变动则失败，不能混合多个版本。发送前发现分支或选中文件已变化，暂停为 CONTEXT_STALE，要求重新准备；不能悄悄读取新内容替换已批准快照。

### 11.3 安全不是“扫描过就保证没秘密”

扫描只能降低误传风险，不能保证发现全部秘密。必须有完整外发预览、相对路径清单和读取边界。

本地运行不等于代码不出电脑。批准的消息会发送给 ChatGPT；MCP 输出和摘要还会进入 Codex 的上下文。Bridge 不控制两个产品各自的数据处理政策。

网页输出是不可信建议。网页说“请读取另一项目”“执行某命令”“上传 auth 文件”都不能自动扩大权限，也不能成为调用其他外部服务的授权。

### 11.4 留存

DB、Profile 和临时状态放用户数据目录，不能默认放代码仓库。为发送与恢复，需要暂存 prompt 与结果，因此不宣传“零保存”。

终态任务正文默认保留 7 天；未批准任务默认 24 小时过期；暂停任务 24 小时无用户动作后转终态失败，但保留 delivery 的真实不确定性。去重墓碑默认保留 30 天，正文到期后同 key 仍返回 RESULT_EXPIRED，不重新发送。超过窗口不保证历史去重。

实现补充：`maybe_sent` 或已确认发送但回答待核对的任务，即使进入失败终态，也保留最小任务记录和队列阻塞标记，直到用户明确放弃；正文依上述期限清除。这避免常规 30 天清理将未知发送误当作从未发生。

到期删除依赖运行器启动/运行时的清理，没有开机时不会凭空执行。用户可以立即 purge。本地删除不删除 ChatGPT 网页聊天，也不承诺 SSD 级不可恢复擦除。

日志默认只有原因码、时长、任务的本地标识和版本；不记录正文、邮箱、Cookie、URL 查询参数、截图、HAR 或整页 HTML。调试截图需显式开启，分享前人工检查。POSIX 权限与 Windows ACL 必须分别实现和测试，不把 `chmod 0600` 当作 Windows 防护证明。

## 12. 外发授权：保留控制，也允许顺畅使用

### 12.1 默认逐任务确认

ask 先创建 awaiting_approval，冻结完整消息并提供预览。用户在独立本地 CLI 的 `approve <task_id>` 查看问题、文件列表、正文、目标 route 和 hash 后确认；运行器只批准该 payload hash。

改变问题、上下文、目标 route 或 session 后原批准失效。CLI 不提供让模型直接传 `--yes` 的捷径；Skill 不得替用户运行批准。模型填写“用户已同意”的文字不是可靠授权记录。

### 12.2 用户可主动开启限时限量授权

为避免每次来回切终端，CLI 可提供 `authorize-session`，由用户明确选择当前项目、固定 route、允许路径、有效期和最大发送数。建议默认 60 分钟、最多 3 次发送；这不是网站额度规则。

有效期间，范围内且扫描通过的任务可直接排队。新增未授权文件、跨项目、换登录状态、换 route、超过次数/时间都必须重新确认。敏感内容拦截不能被此授权关闭。

逐任务批准优先采用精确 hash；限时授权采用明确的项目/路径/预算边界，两者都在运行器中执行。内部字段不能通过普通 MCP 参数修改。

用户后续明确选择无项目纯文字自动发送时，可在本机 MCP 配置启用 `CODEX_PRO_BRIDGE_AUTO_TEXT=1`。运行器只对私有无项目绑定、没有文件上下文且通过扫描的问题，创建与任务 ID、完整正文 hash、当前 route 和登录版本绑定的一次发送 grant；grant 有效期 60 分钟，每滚动 60 分钟最多发放三条。发送意图仍会消耗 grant，登录或选项变化仍撤销 grant。超出额度时回到待批准；普通项目及其文件不适用此开关。此本机设置不能解除浏览器访问权限要求。

### 12.3 威胁模型

独立 CLI、文件权限和本地 token 用来降低误操作、网页诱导和其他普通用户进程的风险，不是对抗已经拥有同一系统用户完整权限的恶意程序的强隔离。TTY 确认本身也不是不可伪造的“真人证明”。

不能宣称 Bridge 可以阻止被完全控制的 Codex 通过其他工具读取文件、修改授权库或直接操作浏览器。需要对抗这一类威胁时，要引入独立权限域和宿主安全控制，不纳入 V0 伪装实现。

宿主 MCP 审批可以作为额外确认层，但在没有验证其语义和可信通道前，不用它替代运行器授权。不要自动把所有工具配置成免确认。

## 13. 项目与对话隔离

每个实际工作目录注册独立 project_id。Git worktree 默认独立注册，不因仓库名字相同而共用对话。记录规范路径、根目录身份、分支和 workspace_epoch，不读取 remote URL 作为公共项目标识。

**V0 默认使用项目级 MCP 配置。**MCP 入口启动时绑定 `--project <id>`，工具参数 project_id 必须与此一致；不允许模型通过传另一个合法项目 ID访问其他已注册项目。

setup 为当前受信任的项目生成 `.codex/config.toml` 中本产品的配置段。Codex 官方支持项目级 MCP 配置，但受项目信任条件约束。[O1] 新项目需要用户执行一次 project init/setup；不能依赖 MCP 自动推断当前仓库。

同一个项目可有多个 session。每个 session 绑定 project、workspace_epoch、profile、login_epoch、route 和对话 URL。继续会话只能使用匹配记录，禁止任意 URL 参数从 MCP 进入浏览器。

切换分支或更换工作目录身份时增加 workspace_epoch，暂停旧会话的继续使用，默认新建对话。相同分支上新的提交不一定要换会话，但每次提供新上下文都必须带版本说明；返回建议仍针对当时快照，应用前由 Codex 核对当前代码。

模型可读取的 project/session 名称只是提示，不是安全依据；归属验证必须落在代码和数据库约束中。

## 14. 回答格式与可验证证据

默认保存网页回答可见正文的 Markdown 表示，不通过另一个模型先概括，不因“答案不符合 JSON”自动再发修复提示。

需要保留代码块、缩进、语言标签、列表、表格、可见链接。不能默认使用全局剪贴板，不能混入侧栏、其他消息、占位思考提示。网页特有引用若无法保留，标为链接/引用转换不完整，不自己编造来源。

每次结果保存：任务与会话标识、提交/完成时间、问题与上下文 hash、页面选项前后证据、消息关联证据、完成信号、正文 hash、适配器/客户端版本和警告。

PLAN/REVIEW/DEBUG 模板可以请求固定小节，但格式不匹配只产生 format_warning，原文仍保留。传输正确不等于答案正确，Codex 必须自行核验建议，不能把网页的“审查通过”直接映射为本地测试通过。

## 15. CLI、安装与卸载

### 15.1 CLI 命令面

| 命令 | 用途 |
|---|---|
| setup | 检测环境、选择项目、预览并注册 MCP、初始化目录 |
| login | 打开专用浏览器供用户手动登录 |
| route configure | 用户选择/记录可见网页选项 |
| doctor / doctor --live | 本地诊断 / 不发 prompt 的页面诊断 |
| serve --project <id> | stdio MCP 入口 |
| project init / list / remove | 当前用户显式管理工作区绑定 |
| approve <task_id> | 逐任务预览并批准 |
| authorize-session / revoke | 创建或撤销限时限量授权 |
| tasks list / show / resume / cancel | 诊断与人工恢复 |
| sessions reconcile | 用户明确指定对话用于未知提交核对 |
| shutdown | 安全停止运行器；有活动任务时必须确认 |
| uninstall / purge | 移除自身配置 / 明确删除本地敏感数据 |

这些命令都必须在实际实现后才能当作安装教程。包名未发布前，不给用户猜测的 `npx ...@latest` 命令。

### 15.2 开发态示例

下列命令约定源码与 scripts 已按本方案生成之后才成立：

```bash
npm ci
npm run build
node dist/cli.js setup --client codex --project <本地项目目录>
node dist/cli.js login
node dist/cli.js doctor --live
```

安装器保存实际 node 和入口文件绝对路径，避免桌面 GUI 的 PATH 与终端不一致。安装失败要回滚自己已修改的内容，不删除其他 MCP。

### 15.3 配置示意

以下路径与 ID是占位示例，setup 应生成真实值：

```toml
[mcp_servers.codex-pro-bridge]
command = 'C:\absolute\path\node.exe'
args = ['C:\absolute\path\codex-pro-bridge\dist\cli.js', 'serve', '--project', 'prj_example']
startup_timeout_sec = 15
tool_timeout_sec = 45
```

这些 timeout 是本方案的建议值，不更改全局默认。服务器启动不应等待浏览器登录。Codex 管理策略可能限制 MCP，程序需要报告限制，不改全局 sandbox 或绕过企业设置。[O1]

编辑 TOML 必须解析、检查旧内容、备份、原子写入、仅修改自有段。保留用户已有模型、API、其他 MCP 与审批设置。项目级配置包含机器路径，setup 应提示不要提交个人机器配置；若文件已被 Git 跟踪，不能擅自删除或修改整个文件的跟踪状态。

uninstall 只移除本产品注册与安装文件；正在运行的任务需先处理。purge 才明确清理 Profile、数据库和授权状态，不自动删除网页聊天，不影响用户日常 Chrome。

## 16. 可选 Skill

Skill 名称同产品：`codex-pro-bridge`。它只引用五个已注册工具，不包含浏览器坐标/选择器，不偷偷启动其他桥。

默认不对每个小任务调用 Pro。只有用户明确提出咨询，或事先授权本次有边界的协作流程，才发起 ask。

一次可选的规划—实现—审查流程为：收集上下文 → PLAN → Codex 实现与测试 → REVIEW → 必要时 Codex 修复。首轮计划与审查最多两次网页提交；再次复核必须在用户明确给定的第三次预算内，否则停下汇报。不能无限循环到两个模型互相表示满意。

这是 Skill 的流程预算，不是只靠提示词执行的安全边界；发送数量仍由运行器授权预算约束。普通独立 ask 与此流程区分，不强迫用户每次走完整链路。

## 17. 支持平台与非功能要求

首个正式验收目标：Windows 11 原生本地 Codex + Chrome，完成后再验证 Edge。macOS 作为第二平台，通过同一套协议/安装/恢复测试后再宣布支持。Windows 10、Linux、WSL 跨系统连接、云端 Codex 和其他客户端，不列入未经测试的承诺。

安装与日常使用不需要云服务器、域名、Supabase、额外模型 API 或作者的后台账户。网络由用户已有浏览器访问 ChatGPT；浏览器登录和使用权限仍是外部前提。

MCP stdout 仅允许协议内容；诊断写 stderr。每个版本公布 Node、SDK、Codex、浏览器、OS、页面语言与适配器版本的实测组合。依赖固定版本，不在启动时下载最新脚本或远程执行修复补丁。

默认关闭遥测。不引入模型身份探针或偷偷发送测试消息。发布后的维护重点是网页适配与回归测试，而不是自建云后台。

## 18. 错误分类

| 原因码 | 处理 |
|---|---|
| WORKSPACE_UNBOUND / PROJECT_MISMATCH | 拒绝读取与发送，重新注册或修正绑定 |
| APPROVAL_REQUIRED / APPROVAL_EXPIRED | 等待用户确认，不自动放行 |
| CONTEXT_BLOCKED / CONTEXT_TOO_LARGE / CONTEXT_STALE | 更小范围重新准备；不静默删内容或分批发送 |
| LOGIN_REQUIRED / WORKSPACE_CHANGED | 用户处理，旧 grant 失效 |
| ROUTE_UNAVAILABLE / ROUTE_UNVERIFIABLE | 未发送时停止，不改其他模型 |
| ROUTE_CHANGED_AFTER_SEND | 保留回答，但不报告已验证 Pro 成功 |
| PROFILE_BUSY / QUEUE_FULL | 返回现状，不另建共享账号或浏览器竞争 |
| USER_INTERFERENCE / UI_UNSUPPORTED | 暂停，不能覆盖用户操作或猜测点击 |
| CHALLENGE_REQUIRED / RATE_LIMITED | 队列暂停，需要人工处理 |
| DELIVERY_UNKNOWN | 只核对原请求，绝不盲目重发 |
| RESPONSE_TIMEOUT / RESPONSE_UNVERIFIABLE | 保存明确的部分内容，恢复观察或人工核对 |
| IDEMPOTENCY_CONFLICT | 同 key 的内容不同，明确拒绝 |
| RESULT_EXPIRED | 告知结果过期，不用同 key 重发 |
| RUNTIME_UNAVAILABLE / IPC_UNAUTHORIZED | 不执行浏览器动作；检查本地服务与权限 |

错误返回可包含 safe_message、delivery、task_id、next_action，但不能把底层堆栈、密钥、个人页面内容原样返回给模型。

## 19. 测试与发布验收

### 19.1 确定性离线测试

| 测试组 | 必须覆盖的情形 | 必须满足 |
|---|---|---|
| 协议 | 初始化、工具列表、输入/输出 schema、stdout 污染 | 与锁定客户端兼容，错误可解析 |
| 去重 | 相同 key/内容、相同 key/不同内容、跨进程竞争 | 单任务或明确冲突 |
| 崩溃 | 写发送意图前后、点击后、回复捕获前后 | 不重发未知请求，不伪造成功 |
| 回复关联 | 已有旧回答、新用户消息没出现、手动插入消息 | 不把旧答案当新答案 |
| 完成判定 | 生成暂停、空正文、按钮未识别、局部失败 | 不误报 completed |
| 并发 | 两个客户端、两个项目、同一 session | 全局串行，不能串项目 |
| 会话 | 分支/worktree 切换、首次 URL 未保存 | 隔离或明确未知 |
| 账户/路线 | 退出、切工作区、无 Pro、选项改变 | 停止且不替换 |
| 输入边界 | traversal、symlink/junction、删除文件 diff、原子快照 | 不越界、不混合版本 |
| 内容保护 | 秘钥在 question/notes/diff/源码中 | 阻止外发，错误不泄密 |
| 审批 | 过期、改 payload、用完次数、变更登录状态 | 原批准不能继续使用 |
| 取消 | 发送前、生成中、停止未确认、已完成 | 如实区分，不宣称撤回数据 |
| IPC | 缺 token、错 token、Origin/Host 欺骗、启动竞争 | 无未授权动作，无双运行器 |
| 序列化 | 中文、代码缩进、超长行、表格、分页 | 拼接保持目标正文完整 |
| 留存 | 7 天正文/30 天墓碑、结果过期同 key | 到期不自动重发 |
| 安装 | 既有 TOML、GUI PATH、卸载、配置冲突 | 不破坏原有设置 |

用合成 HTML 模拟页面状态；mock 只是内部测试实现，不得在真实浏览器失败时静默切回 mock 并标成功。

### 19.2 真实环境验收

真实网页自动化须核对适用条款与所需授权；测试材料由用户明确批准，不含秘密，不做批量抓取/压力测试，不绕过限额。

逐项验证安装、手动登录、可见 route、一次新问答、一次追问、一次局部代码审查、等待后获取结果、人工中断与恢复。记录完整尝试数、正确完成数、人工介入、网页适配失败、账户限制、重复发送、错取回复和环境版本。

“零串项目、零错误关联、零盲目重发”是离线故障测试的硬门槛，不是声称真实环境永不出错。正常场景正确完成率可以设为 ≥95% 的观察目标，但必须披露分子、分母和环境；少量样本不能证明长期可靠性。

### 19.3 完成定义

MCP 接入、软件构建、离线测试、真实浏览器闭环、失败恢复、安装卸载和限制文档全部有证据，才称 V0 可用。没有真实网页结果，只能称“底座已完成/网页未验收”。

MCP 握手成功 ≠ 已登录；已登录 ≠ Pro 可选；页面选中 Pro ≠ 后台模型身份证明；获取文字 ≠ 获取了本次完整回复；传输成功 ≠ 代码建议正确。

## 20. 代码结构与开发阶段

```text
codex-pro-bridge/
├─ package.json
├─ package-lock.json
├─ src/
│  ├─ cli/                 # 安装、登录、授权、诊断与恢复
│  ├─ mcp/                 # 五个工具、schema、instructions
│  ├─ runtime/             # 单实例、IPC、调度、取消
│  ├─ browser/             # 接口、Playwright、选择器、消息观察
│  ├─ context/             # 文件片段、diff、快照与扫描
│  ├─ state/               # SQLite、事务、迁移与留存
│  └─ security/            # 路径、授权、权限与脱敏
├─ skills/codex-pro-bridge/SKILL.md
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ live/
└─ docs/
   ├─ PRD.md
   ├─ TECH_SPEC.md
   ├─ CONTEXT.md
   ├─ DECISIONS.md
   ├─ TODO.md
   └─ VALIDATION.md
```

保持一个仓库、一个发布包；不为 V0 引入微服务、Redis、远程配置中心或完整桌面 UI。

| 阶段 | 工作 | 退出条件 |
|---|---|---|
| A：协议骨架 | 锁依赖、五工具、schema、DB、模拟网页与测试 | Codex 能调用本地状态/模拟任务；清楚标为模拟 |
| B：可恢复底座 | 单实例、IPC、队列、去重、审批、上下文边界 | 故障注入、权限和并发测试通过 |
| C：真实网页 | 专用 Profile、route、发送关联、完成提取、取消 | 授权条件下真实闭环和关键异常有证据 |
| D：可交付 V0 | setup、诊断、卸载、可选 Skill、Windows 验收 | 从干净环境安装与卸载，不要求私有 Runtime |

阶段不是让用户先做一个 Skill 再推倒重来；从 A 开始就是同一个 MCP 产品架构。后续只补全内部模块。

## 21. 风险、对标与不夸大的发布方式

### 21.1 服务条款

OpenAI 当前个人服务条款明确包含对自动或程序化提取数据/Output、规避限额和保护措施的限制。[O8] 网页自动化、MCP 封装、低频自用和用户点击确认都不自动形成例外。

本规格不构成官方授权，也不把风险推迟到“上线后再说”。软件底座可用合成网页测试；真实自动化的启用、公开服务承诺和商业化必须单独核对适用条款、所需授权和账户风险。不要把“免责声明”当许可，不承诺绝不限制账户。

### 21.2 参考项目的取舍

| 参考 | 学习内容 | 不直接沿用 |
|---|---|---|
| yichen-codex-chatgpt | 角色分工、有限审查循环、证据边界 | 未公开 Runtime、受限许可的 Skill/提示词/源码 |
| Goudu666/chatgpt-web-mcp | 专用 Profile、串行化、错误暂停 | 内部历史接口、模型身份探针、全部低层工具 |
| RPG-478/codex-chatgpt-bridge | 适配器分层、页面选项检查 | 一次长阻塞工具调用、缺少明确关联的结果降级 |
| codex-chatgpt-pro-plugin | 项目对话、调用记录、上下文确认 | 默认过量保存截图/网络内容；本项目自行设计短调用 |
| chrisliu298/chatgpt | 简洁的咨询与追问流程 | 每次由模型逐步操作网页的完整编排 |
| codex-browser-bridge | 诊断、权限边界、通用工具思路 | 特定桌面内部管道作为强制依赖 |

这些是已有静态研究的参考，不是证明我们更强的排名。实际复用代码前重新核验文件、版本与许可；yichen 的公开许可存在商业与再分发限制，不能仅改名打包发布。优先独立实现产品逻辑，使用官方 SDK 与可核验许可依赖。

### 21.3 对标目标

只对明确版本、等价已授权环境比较：安装步骤、正常任务正确完成、错误关联、重复发送、人工介入、恢复成功、工具调用次数和桥接本地开销。区分网站生成耗时与软件开销。

先把这些记录完整，再判断是否优于参考项目。工具数量、代码行数、演示成功一次和“架构看起来完整”均不构成优势证据。

## 23. 资料来源与核验说明

以下资料支持外部能力/限制，产品接口与阈值则是本方案自行拟定。官方资料于本轮重新打开核对；仓库资料沿用本对话此前的静态读取快照，未声称本轮重新运行仓库或重新读取全部源码。

### 官方资料

- [O1] Codex MCP，stdio、项目配置、instructions、工具超时：`https://developers.openai.com/codex/mcp`；本轮重定向至 `https://learn.chatgpt.com/docs/extend/mcp?surface=cli`。
- [O2] Codex Authentication，订阅/API 登录路径：`https://developers.openai.com/codex/auth/`；本轮重定向至 `https://learn.chatgpt.com/docs/auth`。
- [O3] MCP 官方 SDK：`https://modelcontextprotocol.io/docs/sdk`；TypeScript 文档：`https://ts.sdk.modelcontextprotocol.io/`。实现时锁定并验证版本，不假设文档最新版本必然与用户 Codex 兼容。
- [O4] Playwright BrowserType / launchPersistentContext：`https://playwright.dev/docs/api/class-browsertype`。
- [O5] Node.js Releases：`https://nodejs.org/en/about/previous-releases`；本轮 v24 标记为 LTS。
- [O6] MCP Tools：`https://modelcontextprotocol.io/specification/2026-07-28/server/tools`；用于结构化返回、显式状态句柄和不可信 annotations。具体线协议交给经验证的 SDK。
- [O7] Node.js 24.0.0 SQLite 文档：`https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html`。这是版本化文档，不等于对以后每个小版本成熟度的保证。
- [O8] OpenAI ROW Terms of Use：`https://openai.com/policies/row-terms-of-use/`；页面标注 2026-01-01 生效。账户实际适用条款还取决于地区/产品/合同；不以此文件代替个案法律意见。

### 参考项目

- [R1] `https://github.com/mcncarl/yichen-skills/tree/main/yichen-codex-chatgpt`；参考 README、references/setup.md 与根 LICENSE。setup 文件既有读取 blob：`e413c5088b090baf3a636f1db782b4a82b2ff91c`。
- [R2] `https://github.com/Goudu666/chatgpt-web-mcp`；参考 README.en.md、src/index.js 的已读部分。README 既有读取 blob：`932102e327371e0ff4f57fcb0a427f314dd9769a`。
- [R3] `https://github.com/RPG-478/codex-chatgpt-bridge`；参考 README、src/mcp.ts 与 src/adapters/playwright.ts 的已读部分。适配器既有读取 blob：`7512d9637dd1b22f672a11807065ccca8166992e`。
- [R4] `https://github.com/pauljunsukhan/codex-chatgpt-pro-plugin`；参考 README 与调用契约的已读部分。契约既有读取 blob：`44c96f372e7887c9b4497fbf7824848f1ead3e3a`。
- [R5] `https://github.com/chrisliu298/chatgpt`；参考 README。既有读取 blob：`196e0d583d51582e581a8523e1501bc11e1089d1`。
- [R6] `https://github.com/DeliciousBuding/codex-browser-bridge`；参考此前可见 README 架构/依赖段落，不据截断部分推断未读源码。

上述 blob 是文件内容标识，不是完整仓库提交版本。正式复用/对标时另行固定 commit、依赖与运行环境。
