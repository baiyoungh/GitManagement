# 发布前检查与发布流程

本流程适用于创建新的 `v*` tag。最近一次问题及处理见 [Windows 发布失败复盘](incidents/2026-10-30-windows-release.md)。

## 触发规则

| 操作 | 双平台测试 | 双平台打包 | GitHub Release |
| --- | --- | --- | --- |
| 普通分支 push（包括 main） | 不自动触发 | 不触发 | 不触发 |
| PR 创建或更新 | 运行 | 不触发 | 不触发 |
| 手动运行 build 工作流 | 运行 | 测试通过后运行，上传 Actions artifacts | 不创建 |
| 推送 `v*` tag | 运行 | 测试通过后运行 | 两平台打包成功后创建并上传安装包 |

分支 push 如果同时更新已有 PR，会触发 PR 测试，但不会发布。发布任务还单独要求事件为 `push` 且 ref 为 `refs/tags/v*`，手动预检不会发布。

## 1. 准备候选提交

- [ ] 确认目标分支和改动范围；先准备版本文件、发布说明及全部修复，再验证最终候选提交。
- [ ] `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的本包版本和 `src-tauri/tauri.conf.json` 一致；存在 `docs/releases/v<版本>.md`。
- [ ] 执行 `pnpm install --frozen-lockfile`，然后执行 `pnpm release:check`。

`release:check` 依次检查版本及发布说明、前端生产构建（含类型检查）、前端全部测试和 `cargo test --locked`。`release:versions` 通过 Cargo metadata 读取 Rust 版本；CI 在 tag 事件中还会检查 tag 名是否等于 `v<版本>`。本地检查只覆盖当前操作系统。

## 2. tag 前跨平台预检

- [ ] 提交并推送候选代码，创建或更新 PR，等待 macOS / Windows 测试都成功；记录候选 SHA 及对应运行链接。
- [ ] 手动运行 build 工作流，选择候选分支，确认运行的 `headSha` 等于候选 SHA；两平台测试与打包都成功。
- [ ] 确认 Actions artifacts 同时包含 macOS 通用 DMG 和 Windows x64 EXE；版本、架构及文件名符合预期。
- [ ] 涉及终端或系统集成时，在目标平台进行原生交互检查：启动终端、执行 `pwd` / `cd`、输入、调整尺寸、关闭和重新打开。确认关闭后无报错、无残留 shell；macOS 通过不能代替 Windows 检查。
- [ ] 如果之后修改候选代码、版本或依赖，重新验证新 SHA，不能使用旧提交的通过记录。

手动入口：GitHub Actions → build → Run workflow，或 `gh workflow run build.yml --ref <候选分支>`。随后用 `gh run list --workflow build.yml --event workflow_dispatch --branch <候选分支>` 找到运行，检查 `gh run view <运行ID> --json headSha,status,conclusion,jobs`，再用 `gh run watch <运行ID> --exit-status` 等待完成。

GitHub 需要默认分支包含 `workflow_dispatch` 定义才显示手动入口；当前改动合并到 main 后该入口才可用。在此之前先使用 PR 做双平台测试，不能把尚未执行的手动打包记为通过。

## 3. 创建 tag 并确认发布

- [ ] 记录预检通过的候选 SHA；确认版本、发布说明及 tag 名一致，远端不存在该 tag。
- [ ] 将附注 tag 建在该候选 SHA 上：`git tag -a v<版本> <候选SHA> -m "Release v<版本>"`。
- [ ] 仅在用户授权发布时执行 `git push origin refs/tags/v<版本>`，避免 `git push --tags` 顺带推送其他本地 tag。
- [ ] 等待 tag 对应工作流的 test、两平台 bundle、release 全部成功。
- [ ] 确认 Release 已发布且不是草稿，DMG / EXE 两个附件均为 uploaded，并核对版本和大小。只有测试通过或 Actions artifact 存在还不算发布完成。

## 失败处理与仅推送代码

查看失败日志：`gh run view <运行ID> --log-failed`。先区分测试、编译、签名、上传或 Release 创建失败，再处理对应环节。代码缺陷修复后先在分支预检；保留已推送 tag，使用新的补丁版本。确认只是网络或 runner 等偶发问题且代码未变时，才重跑失败任务。

用户要求只推送代码时，只提交并推送指定分支，不创建或推送 tag，不创建 Release，也不手动触发打包。本次文档及流程调整按此方式提交。
