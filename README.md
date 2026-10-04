# Codex Pro Bridge

Codex 与 ChatGPT Chat 网页高推理档位的非官方协作桥。当前 `0.1.0-alpha.1` 是**实验开发版**。本地 MCP、任务和安装底座已在 Windows 11 原生环境通过离线测试与打包安装验收；Agent 浏览器模式已在 macOS 用户现有 Chrome 的 `6 Pro` 会话中完成新问题、同一对话追问和示例代码审查，三项回答都写回桥接任务。`High` 路由已通过离线集成测试，尚未在 Plus 账号真实网页验收。Windows 11 上的真实 Chrome 网页闭环与更广泛的网页异常场景仍待验收。

## 本地运行

需要 Node.js 24.16.0 或更新的受支持版本。此仓库尚未发布 npm 包。

```sh
npm ci
npm run build
codex mcp add codex-pro-bridge --env CODEX_PRO_BRIDGE_BROWSER=agent -- "$(command -v node)" "$(pwd)/dist/src/cli/index.js" serve --auto
CODEX_PRO_BRIDGE_BROWSER=agent node dist/src/cli/index.js doctor
```

希望 Codex 在新任务中自动完成本地 Bridge 工具调用时，可在个人 `~/.codex/config.toml` 的 `[mcp_servers.codex-pro-bridge]` 中设置 `default_tools_approval_mode = "approve"`，并在个人 `~/.codex/AGENTS.md` 中写明需要主动咨询 Pro 的任务类型。此设置只影响 Codex 对 Bridge MCP 工具的宿主批准；Bridge 自身的网页外发授权与防重复发送约束仍生效。

若用户明确选择**纯文字自动发送**，可在个人配置的 `[mcp_servers.codex-pro-bridge.env]` 下加入 `CODEX_PRO_BRIDGE_AUTO_TEXT = "1"`，随后重启 Bridge 运行器。Bridge 为项目内和无项目、且没有文件上下文的问题自动建立与完整消息哈希绑定的一次发送授权，不设每小时自动授权次数上限；敏感内容扫描、账户/选项核对、发送账本和异常暂停仍执行。最多同时有五条等待任务，队列满时须等已有任务结束。项目文件及其上下文包不会因此自动发送。未启用时继续逐条批准或使用有限会话授权。

全局 MCP 一次安装后会出现在本机新开的 Codex 任务中。有项目的任务首次需要网页高档协作时，调用 `codex_pro_bind_project` 自动注册当前项目的准确根目录；无项目对话调用同一工具时省略 `root`，可咨询纯文字问题。绑定只在本地建立任务边界，不会发送内容到网页。无项目入口拒绝文件上下文，代码审查应在对应项目任务中进行。旧的 `setup --root /path/to/project` 仍可安装项目专用 MCP：它会预览拟加入项目 `.codex/config.toml` 的配置，仅在本地输入 `yes` 后写入，不更改 Codex 主模型或其他 MCP 配置。配置含本机绝对路径，不应提交；旧配置备份留在产品私有数据目录。

Agent 浏览器模式由 Codex 的 Computer Use 操作用户已登录的 Chrome。运行任务的 Codex 环境需要提供该浏览器工具，并安装随包的 [Skill](skills/codex-pro-bridge/SKILL.md) 到个人 Codex 技能目录（本机为 `~/.codex/skills/codex-pro-bridge/`）。有限授权覆盖本次内容时，Codex 可以根据重大方案、复杂诊断或关键审查任务主动选择网页当前账号可用的最高高推理档位；普通小任务直接由 Codex 完成，不默认转到网页 Instant。当前 Bridge 高档路径不支持 Instant。Skill 核对账户、可见档位、发送标记和回答。已有登录可复用；每次咨询仍受项目、选定内容和有限授权约束。测试记录见下文。

**登录与账号边界：**新任务创建前必须在 Chrome 网页上看到已登录账号；未登录时停止，不创建待发送网页任务。Bridge 在本地保存此前绑定的网页账号标识哈希；若当前账号不同，绑定返回 `ACCOUNT_MISMATCH`，不会自动把问题发给另一个账号。用户明确要求改用当前账号时，才允许本次 `agent bind-route` 带 `account_switch_authorized:true`；旧授权会撤销，未发送任务会暂停。账号核对依赖页面可见标识，不独立验证后台账号身份。

**档位与来源：**以 ChatGPT **Chat 网页**的实际可选项为准。按 [OpenAI 当前说明](https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt)，Plus 的最高高推理档位为 `High`，没有 Chat 网页的 Pro 档；符合条件的 Pro、Business 和 Enterprise 账户可能显示 `6 Pro`。若 Pro 因额度用完而禁用，新建任务会在创建前核对页面并选择实际可用的最高高推理档位，例如 `极高` 或 `High`。已创建、已发送或状态不确定的任务不会换档重发。Plus 在 Codex 或 ChatGPT Work 中能使用的 GPT‑6 Astra，不等于在 Chat 网页能使用 GPT‑6 Pro。回答须写页面实际显示的档位；`极高` 是思考强度，不称作“Pro 回答”，只有页面确实显示 `6 Pro` 时才写“网页 6 Pro 分析”。Bridge 验证的是可见选项，不独立验证后台模型身份。

旧的独立 Playwright 浏览器路径默认关闭；`CODEX_PRO_BRIDGE_LIVE_WEB=1` 只用于显式实验。该专用浏览器首次登录时曾反复出现真人验证，当前不建议用它处理实际任务。Agent 模式不需要此开关，也不会启动独立浏览器。运行器启动后不能中途切换模式；需先 `shutdown` 再以目标模式启动。两种模式及测试结果都不改变适用服务条款。

`project init` 与 `setup` 相同，`project remove` 与 `uninstall` 相同；`project list` 显示已注册项目。Agent 模式的 `doctor` 报告运行器模式；`doctor --live` 不会自行读取 Codex 的浏览器工具，网页状态需由执行 Skill 的 Codex 核对。独立 Playwright 模式默认关闭时，`doctor --live` 返回 `WEB_AUTOMATION_DISABLED`。

若离线测试中的任务处于“可能已发送”且无法核对，`tasks abandon TASK_ID` 可在本地终端确认后放弃原任务并释放队列；这不撤回已经可能发送的内容，也不把原任务标成成功。

`sessions reconcile TASK_ID` 可在本地终端粘贴官方对话地址，作为待核对候选。它只绑定地址；启用实验网页适配器后仍须实际核对回答，候选地址不会直接变成已验证会话。

本地任务数据保存在用户数据目录，不在仓库中；独立 Playwright 模式的浏览器资料也位于该目录。Agent 模式使用现有 Chrome 会话，不复制其登录资料。`uninstall --root /path/to/project` 仅移除本产品的项目配置并停用绑定；不会删除本地任务数据或网页聊天。

`purge` 需要在本地交互终端输入确认词，会停止运行器并删除本产品的任务数据库、迁移备份与专用浏览器资料。它保留项目配置及网页聊天；下次调用仍可能重新创建本地数据。

## 验证

```sh
npm test
npm run typecheck
npm audit --omit=dev
```

测试结果、已知缺口与环境见 [验证记录](docs/VALIDATION.md)。产品范围见 [产品需求](docs/PRD.md)，设计契约见 [技术规格](docs/TECH_SPEC.md)；全局项目接入的变更见 [ADR 0002](docs/ADR-0002-global-project-binding.md)。启用真实网页适配器后，选中并批准发送的项目内容会进入 ChatGPT；本地运行不代表内容始终留在电脑里。
