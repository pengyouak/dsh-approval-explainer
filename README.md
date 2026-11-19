# dsh-approval-explainer

一个 DeepSeek Harness（DSH）插件：把 Agent 弹出的**授权/危险操作提示**翻译成普通人能读懂的说明，用**危险等级标签（高危/中危/低危）**标注风险，并在**右侧栏**列出每次授权的解释、命令与结果。

## 功能

- **拦截授权提示**：在 DSH 的 `approval/request` 瀑布最前端（`prepend + global`）改写弹窗文案。
- **人话解释**：shell 命令 / 文件操作 / 插件管理 / 通用工具都解析成中文说明。
- **危险等级标签**：`⚠️【高危】` / `✎【中危】` / `✓【低危】`，一眼可辨。
- **英文描述转中文**：Harness 生成的英文备注（如 “Profile changes persist…”）自动中文化。
- **右侧栏「授权记录」**：实时列表，含工具、操作说明、备注、原始参数、结果（已允许/已拒绝/已取消/未处理）。
- **零侵入**：只改写展示文本与派生展示数据，从不代替用户放行/拒绝，也不改动审计日志。

## 安装

### 方式 A：插件市场（索引驱动）
1. 启用实验性市场 bundle（`@deepseek-ai/dsh-experimental-plugin-market-bundle`），打开 Plugins → Discover。
2. 添加一个包含本插件的索引 URL（见 `docs/market-index.example.json`）。
3. 从列表安装。

### 方式 B：本地目录
Plugins → Add plugin → 选择本目录。

### 方式 C：npm / git 直接安装
用 `plugin_manager` 的 `install_bundle`，`target` 传 `dsh-approval-explainer@1.0.0`（npm）或 `git+https://…#<commit>`（git）。

> 安装后如为 Web/Desktop 界面，需**刷新页面**让客户端模块加载。

## 发布前需要改的地方

1. **包名**：`package.json` 的 `name` 换成你自己的唯一 npm 名（可用 scope，如 `@yourscope/dsh-approval-explainer`），并同步改 `cordis.patch.yml` 的 `name` 与 `client.js` 里 `window.__ModuleLoader__.load({ id })` 的值（三者必须一致）。
2. **元数据**：补 `author` / `repository` / `homepage`。
3. **`engines.dsh`**：已声明 `>=0.2.2-rc.3`，按需调整。
4. `npm publish`（或推到公开 Git 仓库并固定 commit）。

## 依赖

无 npm 运行时依赖。`translator.js` 为纯 JS；Host 半只用到 DSH 上下文；Client 半从浏览器模块表加载 React。

## 许可

MIT
