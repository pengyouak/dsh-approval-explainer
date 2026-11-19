# dsh-approval-explainer

一个 **DeepSeek Harness（DSH）** 插件：把 Agent 弹出的**授权 / 危险操作提示**翻译成普通人能读懂的说明，用**危险等级标签（高危 / 中危 / 低危）**标注风险，并在**右侧栏**持续记录每次授权的解释、原始命令与结果。

> 只改写“展示文本”和派生展示数据：**从不代替用户放行/拒绝**，也不改动审计日志。识别失败会原样放行，绝不阻断审批流程。

## 截图

**授权记录（右侧栏列表）** —— 危险等级标签、操作说明、备注、可展开原始命令、授权时间。

![授权记录](docs/images/approval-records.png)

**授权弹窗** —— 危险等级 + 人话解释 + 备注 + 所需权限 + 原始命令。

![授权弹窗](docs/images/approval-dialog.png)

## 功能特性

### 1. 授权弹窗“说人话”
Agent 请求权限或执行潜在危险操作时，DSH 会弹出确认框。原生弹窗通常只有一行技术性理由；本插件在弹窗**弹出前**拦截请求并重写文案：

- **危险等级标签**：`⚠️【高危】` / `✎【中危】` / `✓【低危】`，一眼可辨。
- **人话解释**：把命令/操作解析成一句中文说明，例如
  `rm -rf node_modules` → 「永久删除 node_modules，删除后无法恢复」。
- **覆盖多类工具**：shell（bash / pwsh）、文件操作（write / edit / delete / rename）、插件管理（`plugin_manager` 的安装/卸载/启停）、以及通用工具的“参数化说明”。
- **英文自动中文化**：Harness 生成的英文备注（如 `Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`）会整句转成中文；已是中文或形似标识符/JSON/路径的文本保持原样。
- **结构化排版**：`危险等级 ｜ 工具 ｜ 操作 ｜ 备注 ｜ 权限 ｜ 原始命令`（弹窗标题不支持换行，故用醒目分隔符单行呈现）。
- **危险动作识别**：格式化磁盘、删除根目录、`dd` 覆写磁盘、管道直接执行下载脚本、删库、关机重启、递归改权限、`sudo`、`Invoke-Expression` 等，按严重程度分级。

### 2. 右侧栏「授权记录」列表
在右侧栏新增一个「授权记录」页签，**实时**列出本次会话每一次授权的历史：

- **危险等级标签**（含配色左边框，按级别着色）；
- **操作说明**（中文，来自翻译）；
- **备注**（Agent 给出的理由，自动中文化）；
- **授权时间**：`yyyy-MM-dd HH:mm:ss`（本地时区），位于「原始命令」同一行右侧；
- **可展开原始命令**：默认折叠，点 `▸ 原始命令` 展开，以灰色、较小等宽字体显示原始命令/参数；
- **结果**：已允许 / 已拒绝 / 已取消 / 未处理；
- **可滚动**：长列表在面板内独立滚动（不受宿主 `overflow:hidden` 影响）。

### 3. 零侵入、可预期
- 翻译与危险识别是**确定性规则表**（无网络、无大模型调用），即时且结果稳定。
- 只读取**已记录**的审批事件派生展示数据，不篡改会话日志。
- 任何解析/注册失败都自动降级为原始行为。

## 工作原理

- **弹窗翻译**：Host 侧在 `approval/request` 瀑布事件最前端注册监听（`prepend + global`），同步改写请求的 `displayReason`（仅展示用；审计事件里的 `reason` 保持不变）。
- **历史列表**：Host 侧注册一个带 `wire` 视图的**会话投影** `approvalExplainers`，折叠 `approval/asked` / `approval/decided` / `tool/call` 事件生成记录；Client 侧用会话标准钩子 `useProjection('approvalExplainers')` 读取并渲染到右侧栏页签。
- **插件形态**：Host 半（`index.js`）负责拦截与投影；Client 半（`client.js`）通过 `window.__ModuleLoader__` 注册右侧栏页签，仅注册到 `sidebar.right.pane.tab`（唯一键），**不占用任何宿主 `single` 槽**。

## 安装

### 方式 A：本地目录（最简单）
Plugins → Add plugin → 选择本仓库目录。

### 方式 B：git 直接安装
用 `plugin_manager` 的 `install_bundle`，`target` 传 `git+https://github.com/pengyouak/dsh-approval-explainer.git#<commit>`。

### 方式 C：插件市场（索引驱动）
1. 启用实验性市场 bundle（`@deepseek-ai/dsh-experimental-plugin-market-bundle`），打开 Plugins → Discover；
2. 添加一个包含本插件的索引 URL（见 `docs/market-index.example.json`）；
3. 从列表安装。

> 安装/升级后如为 Web / Desktop 界面，请**刷新或重启**以加载最新客户端模块。

## 升级与兼容

- 依赖 DSH 的 `approval/request` 事件、会话投影、右侧栏 slot 等扩展点；已在 `0.2.2-rc.5` 上验证。
- `package.json` 声明 `engines.dsh: ">=0.2.2-rc.3"`。

## 故障排查

**症状：更新 DSH 客户端后，本插件导致应用无法启动，需先禁用插件才能启动。**

- 原因（rc.5 曾出现）：旧版本曾尝试向宿主 `conversation.approval.detail`（一个由 `dsh-client-ui-chat` 独占的 `single` 槽）注册组件，同优先级抢占导致必需的 ui-chat 激活失败，从而 Web 启动失败。崩溃日志 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` 会给出 `single slot "conversation.approval.detail" already has a registration at priority 0`。
- 现状：本版本已**移除**对任何宿主 `single` 槽的注册，仅注册自身右侧栏页签；并对 Host 侧投影注册做了 try/catch 兜底，不会因此阻断启动。
- 若仍遇启动问题：可临时在 Plugins 里禁用本插件启动，查看上述崩溃日志并反馈。

## 发布（npm / Git）

1. 包名：`package.json` 的 `name` 换成你的唯一 npm 名（可用 scope），并同步修改 `cordis.patch.yml` 的 `name` 与 `client.js` 中 `window.__ModuleLoader__.load({ id })` 的值（三者必须一致）。
2. 元数据：补 `author` / `repository` / `homepage`。
3. `engines.dsh` 按需调整。
4. `npm publish`（或推公开 Git 仓库并固定 commit）。

## 依赖

无 npm 运行时依赖：`translator.js` 为纯 JS；Host 半只用 DSH 上下文；Client 半从浏览器模块表加载 React。

## 许可

MIT
