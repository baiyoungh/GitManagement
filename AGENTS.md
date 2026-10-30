# 发布工作约定

- 发布前阅读 `docs/release-process.md`，本次 Windows 故障复盘见 `docs/incidents/2026-10-30-windows-release.md`。
- 只有推送 `v*` tag 才发布；普通分支（包括 main）push 不自动运行发布工作流。PR 运行双平台测试，手动预检运行双平台测试和打包但不创建 Release。
- 创建发布 tag 前，先提交候选代码，通过本地 `pnpm release:check`，并确认相同提交的 macOS/Windows CI 测试及双平台预检打包成功。仅本机通过不代表另一平台通过。
- 如果候选提交或依赖发生变化，重新检查对应候选提交，不沿用旧提交的通过记录。记录 tag 与预检提交的对应关系。
- 用户要求只推送代码时，不创建或推送 tag，不创建 GitHub Release，也不手动触发打包。
- 已推送的失败发布 tag 保留。代码修复通过预检后使用新的补丁版本；基础设施偶发失败且代码未变化时可重跑失败任务。
