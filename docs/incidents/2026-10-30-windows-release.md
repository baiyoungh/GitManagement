# 2026-10-30 Windows 发布失败复盘

## 影响与结果

v0.1.2 和 v0.1.3 在 Windows Rust 终端测试失败，依赖测试结果的 bundle / release 任务被跳过，没有生成对应安装包和 GitHub Release。macOS 测试通过。

最终 v0.1.4 的双平台测试、打包和发布全部成功，安装包为 `GitManagement_0.1.4_universal.dmg` 和 `GitManagement_0.1.4_x64-setup.exe`。原有失败 tag 保留。

## 两次失败与修复

| 版本 | 失败位置与证据 | 原因 | 处理 |
| --- | --- | --- | --- |
| v0.1.2 | `terminal::tests::real_shell_uses_repo_cwd_accepts_input_and_closes` 等待 15 秒后失败，日志输出只有 `ESC[6n` | ConPTY 启动时查询光标位置，测试没有模拟终端的回应，shell 等待握手 | 测试在发送命令前累计输出以识别可能跨数据块的查询，回应 `ESC[1;1R`，并确认工作目录、输入、重复关闭和退出事件 |
| v0.1.3 | 同一测试通过启动及输入阶段，在 `manager.close()` 报 `The handle is invalid. (os error 6)` | `portable-pty 0.9` 的 Windows 克隆终止器反向判断 `TerminateProcess` 返回值：非零表示成功，却返回了错误，还读取了可能已过时的系统错误码 | Windows 会话保留独立的进程句柄，直接正确判断 `TerminateProcess`；终止失败时检查进程是否已经退出，仍然保留真正的系统错误 |

同时修复了界面的启动时序风险：xterm 可能在 `terminal.open` 的异步调用完成前收到查询并产生回应，原先 `!opened` 条件会丢弃回应。现在启动阶段允许发送终端回应，关闭或销毁后仍拒绝输入，并增加对应前端回归测试。该风险由代码检查发现，不能把它与首次 CI 中测试缺少终端模拟器的问题混为一谈。

修复位置：`src-tauri/src/terminal.rs`、`src/components/TerminalPanel.tsx`、`src/components/TerminalPanel.test.tsx`；Windows API 依赖配置在 `src-tauri/Cargo.toml`。

## 验证与可追溯记录

- 本地：前端 67 项测试、Rust 86 项测试、类型检查及前端生产构建通过。
- 修复关闭逻辑后，先推送分支验证，Windows 终端用例和完整 Rust 测试通过，再创建 v0.1.4 tag。
- Windows Rust CI 为 83 项（58 项单测 + 10 / 7 / 8 项集成测试）；macOS 为 86 项，差异来自平台条件编译，不能要求两平台测试数完全一致。
- v0.1.4 发布提交：`44feda7f2925d89d2e40fd5311de68a5736549a7`。

| 记录 | 地址 |
| --- | --- |
| v0.1.2 失败 | https://github.com/baiyoungh/GitManagement/actions/runs/41001655449 |
| v0.1.3 失败 | https://github.com/baiyoungh/GitManagement/actions/runs/41006630978 |
| 关闭逻辑修复后的分支验证 | https://github.com/baiyoungh/GitManagement/actions/runs/41008082481 |
| v0.1.4 成功发布 | https://github.com/baiyoungh/GitManagement/actions/runs/41008699746 |
| Release 与安装包 | https://github.com/baiyoungh/GitManagement/releases/tag/v0.1.4 |

## 为什么没有在 tag 前发现

第一次发布依赖 macOS 本地验证，Windows 分支 CI 未通过就推送了 tag；首次修复后也没有先等 Windows 分支测试完成，导致下一段关闭路径的缺陷在第二个发布 tag 上才暴露。跨平台依赖的接口一致不代表实现行为一致。

以后按 [发布流程](../release-process.md) 先验证候选提交，再发布 tag。保留终端真实进程测试及启动时序回归，不通过跳过测试或单纯延长超时来掩盖问题。Windows 原生界面人工验收仍需独立完成，CI 通过不替代真机交互验收。
