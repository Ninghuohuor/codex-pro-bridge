# ADR 0001: Codex Agent 复用已登录 Chrome

日期：2026-09-25。状态：采用为当前真实网页首选路径。

原规格选择 `playwright-core` 启动独立 Chrome Profile。它在用户日常 Chrome 已登录 Pro 的情况下仍需重新登录；首次登录期间用户报告反复真人验证。独立 Profile 已停止，不能把它的入口检查算作产品闭环。

当前路径由 Codex Computer Use 控制用户已经登录的 Chrome；本地 MCP 运行器继续负责项目边界、内容快照、有限授权、去重、发送意图、对话绑定与回答存储。运行器设置 `CODEX_PRO_BRIDGE_BROWSER=agent` 后不启动独立浏览器。Codex Skill 根据页面上可见的账户与 Pro 选项执行 `bind-route → claim → intent → sent → record_answer`。`intent` 先于网页点击；一旦存在可能发送记录，异常时暂停而不自动重新点击。`sent` 需看到本次用户消息标记和正式官方对话地址；`record_answer` 需看到关联回答与完成控件。回答直接经 MCP 工具提交，避免长中文回答经过交互式终端输入。

此路径在 macOS 用户 Chrome 的已登录 Pro 会话中完成三项真实桥接任务：新问题、同一对话追问和示例代码审查。三项均在本地任务记录中为 `completed`、`confirmed_sent`。账户、选项与回复关联的网页观察由 Codex Browser 工具执行，本地运行器依赖该工具报告的证据；它不能独立证明网页后台实际使用的模型。Windows 11、工具中断、页面人工干预与超长回答仍需单独验收。

2026-09-25：新增 `codex_pro_record_answer` MCP 工具，复用原有 `agent_complete` 校验及任务记录。先前一条真实回答在网页出现后，因长文本经交互式终端录入失败，导致记录阶段重试约三分钟。现在 Skill 要求一次读取正文后直接提交 MCP，成功时不再额外分页重读；离线集成测试验证了长中文回答原样存储、跨项目拒绝与全套回归。网页到 Codex 的真实耗时改善仍需在下一条自然发生的 Pro 任务中计量。

旧 Playwright 代码保留为显式实验路径，不参与 Agent 模式。若未来无法提供 Codex Computer Use，本产品不能声称支持自动真实网页闭环。
