# GitManagement 代码

跨平台桌面 Git 管理工具，Tauri 2 + React + TypeScript。需求见上级目录 `specs/`。

当前实现范围：M0（工程骨架）、M1（多仓库 + 提交）、M2（远端映射 + 冲突解决 + 日志）、M3（正式版 1.0 功能）。M4 增强与托管平台集成尚未开始。

## 环境要求

- Node.js 20+、pnpm 9+
- Rust stable（1.77+）
- git ≥ 2.30
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ Build Tools、WebView2（Win10/11 通常已自带）

## 常用命令

```bash
pnpm install
pnpm icons          # 首次需要：由 app-icon.svg 生成 src-tauri/icons/
pnpm tauri dev      # 开发运行：会自动弹出 GitManagement 窗口

pnpm typecheck      # 前端类型检查
pnpm test           # 前端单测（vitest）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测 + 集成测试（需要本机 git）

pnpm tauri build                                    # 当前平台安装包
pnpm tauri build --target universal-apple-darwin   # macOS 通用包（需先 rustup target add aarch64-apple-darwin x86_64-apple-darwin）
pnpm tauri build --bundles nsis                     # Windows exe
```

`pnpm tauri dev` 期间的 `http://localhost:1420` 只是给应用窗口提供页面的开发服务器。在普通浏览器里打开它没有后端，目录选择、git 操作都不可用，页面只显示一条提示。

产物位于 `src-tauri/target/**/release/bundle/`。CI 配置在 `.github/workflows/build.yml`，推送到 main 或打 `v*` 标签时触发。

## 目录结构

```
src-tauri/src/
  lib.rs / main.rs     入口；main 同时兼任 GIT_ASKPASS 程序
  commands.rs          Tauri commands（前端 invoke 的全部接口）
  git/runner.rs        git 子进程：参数数组、环境变量、取消、进度、命令日志、错误分类
  git/parse.rs         porcelain v2 / for-each-ref / log / numstat / diff 解析
  git/status.rs        状态与进行中操作
  git/changes.rs       勾选提交、Rollback、add、ignore
  git/diff.rs          文件差异（左右全文 + hunk）
  git/branch.rs        分支、upstream、合并/变基、身份
  git/sync.rs          clone / fetch / pull / push / 推送预览
  git/remote.rs        Remote 增删改、连通性测试（M-01）
  git/conflict.rs      冲突列表、三方内容、接受一侧、写回（X-01 ~ X-03）
  git/log.rs           提交分页与过滤、详情、Reset / Revert / Cherry-pick、文件历史、Blame、分支比较、标签、二进制内容
  git/stash.rs         Stash 列表 / 创建 / 应用 / 弹出 / 删除 / 建分支（C-10）
  git/partial.rs       部分提交：按选中的 hunk / 行计算 index 内容（C-03）
  git/precheck.rs      提交前检查：超大文件、疑似密钥、TODO
  system.rs            扫描目录发现仓库（R-03）、在外部打开（R-08）
  sync_engine.rs       同步规则匹配、映射总览、按规则同步（M-02 ~ M-05）
  diff3.rs             三方合并块计算（不依赖冲突标记）
  storage.rs           SQLite 迁移与 DAO（同步规则、分组、变更列表）
  tasks.rs             后台任务队列（每仓库串行、跨仓库并行）
  watcher.rs           文件监听 → repo-changed 事件
  security.rs          脱敏、URL 凭据剥离、系统钥匙串
src/
  api/                 typed invoke 封装、类型、TanStack Query
  stores/              Zustand：UI 状态、任务与命令日志
  lib/                 变更树三态、差异/合并行模型、提交图布局、规则匹配等纯函数（含单测）
  views/               总览、变更、差异（含图片对比）、分支（含比较）、日志、远端映射、Stash
  dialogs/             添加/克隆/扫描、推送预览、分支、标签、Stash、比较、文件历史/Blame、分支弹窗/切换仓库、设置、Remote、规则抽屉、按规则同步、冲突列表、三栏合并
  locales/             zh-CN（默认）、en-US
```

## 与 specs 的对应及实现说明

- 提交按 specs/04 第 2.2 节：先复制 index 文件作为快照 → `reset` 清空 index → 按勾选 `add` → 部分提交文件写入选中内容 → `commit -F`，失败（含 hook）还原 index 文件（比 `write-tree`/`read-tree` 更完整，能保留 intent-to-add 与 skip-worktree）。合并/变基进行中时跳过清空 index；合并 / cherry-pick / revert 冲突解决后可不勾选文件直接提交。
- 部分提交（C-03）：在变更页差异中勾选 hunk（块左侧复选框）或单行（点击行号）。后端不生成 patch，而是直接计算"HEAD + 选中改动"的完整内容，`hash-object --path` 写入后 `update-index --cacheinfo`，不受 CRLF、无结尾换行等 patch 边界问题影响（specs/08 风险项）。差异两侧按工作区形式比较（`cat-file --filters`），Windows `autocrlf=true` 下也只显示真实改动。选择按块内容而不是行号记录：编辑文件其他位置不会让排除的块"串位"；被排除的块内容变化时失败即关闭（新块默认不提交并提示重新确认），提交前还会再次核对 hunk 是否与选择时一致。符号链接、子模块、重命名、二进制和非 UTF-8 文件不支持部分提交。
- 变更列表（C-09）：右键分组新建列表，文件可拖拽或右键移动；未归属的改动进入活动列表；勾选状态与列表归属互相独立，删除列表不影响勾选。
- Stash（C-10）：以 stash 哈希而不是 `stash@{n}` 标识，避免列表变化后删错条目；应用冲突进入冲突解决流程。
- 仓库分组（R-04）：侧栏分组可折叠、拖拽分组标题排序、拖拽仓库换组/排序（多选时一起移动）；⌘/Ctrl 点击多选、⇧ 连续选，多选后顶部出现批量 Fetch / Pull / 同步（R-06），批量同步需确认。
- 偏差检测（M-07）：打开远端映射页时并行检测所有 remote 连通性（缓存 10 分钟），与 remote 缺失、upstream 已删除、upstream 与规则不一致一起汇总在顶部横幅。
- 外部打开（R-08）：macOS 用 `open` / `open -a`，Windows 用 explorer / Windows Terminal（无则 cmd），终端与编辑器在 设置 › 外部工具 中配置。
- 提交前检查：只检查本次新增的行（超大文件、AWS key、私钥、GitHub/GitLab/Slack 令牌、密码赋值，可选 TODO），结果仅作提示。
- 同步规则（specs/03）：精确名优先于通配，同为通配按优先级数字升序；`feature/*` 匹配其下所有层级。前端 `lib/ruleMatch.ts` 与后端 `sync_engine.rs` 使用同一组测试用例保证行为一致。保存规则时 primary target 写入 `branch.<name>.remote/merge`；映射页可在"以 git 配置为准 / 以规则为准"之间处理不一致。
- 按规则同步：先执行 pull/双向目标（fetch → 当前分支按 Pull 策略合并/变基，非当前分支只允许快进），再逐个推送；每个目标独立，失败项可单独重试。拉取产生冲突时中断并进入冲突解决。force 目标默认不勾选，执行前单独确认，使用 `--force-with-lease`。
- 三栏合并（specs/05）：结果栏初始为 Base，块级 » / « 应用、× 忽略、⚡ 应用所有非冲突改动；冲突块两侧都应用时按"先左后右"追加；双击结果栏进入自由编辑。块由 `diff3.rs` 根据 `:1:/:2:/:3:` 三个版本计算，不依赖文件中的冲突标记。
- Rollback 删除的文件通过 `trash` crate 移入系统回收站。
- 凭据：优先使用系统 git credential helper 与 SSH agent；应用自身作为 `GIT_ASKPASS`，只在 helper 未提供凭据时从系统钥匙串读取设置页保存的令牌。克隆 URL、Remote URL、规则中的 URL 目标里的 `user:token@` 都会被剥离后存入钥匙串。
- Rust 侧只返回错误码 + 参数，界面文案全部在 `src/locales/`。
- Tauri capabilities 只开放 `core:default` 与 `dialog:allow-open`，前端无 shell / 任意文件系统权限。

## 验证状态

在 Linux (aarch64) 沙盒中验证通过：`tsc --noEmit`、vitest 36 项、`vite build`、完整 Tauri 工程 `cargo test` 74 项（51 项单测 + 9 项 M1、7 项 M2、7 项 M3 集成测试）。

M3 集成测试覆盖：hunk 级与行级部分提交（含中文/空格路径、未跟踪新文件、CRLF 与无结尾换行、`autocrlf=true` + `safecrlf=true`、文件名含 `[]`）、hook 失败后 intent-to-add 保留、Stash 全流程（仅选中文件、含未跟踪、按哈希 pop、冲突、建分支）、标签新建/推送/删除远端、分支比较与工作区比较、跨重命名的文件历史、含未提交行的 Blame、作者/日期/路径过滤、提交前检查只报新增行；另有分组/变更列表存储、扫描目录的单测。

性能粗测（沙盒中 debug 构建，5000 文件 + 2000 提交的仓库）：干净状态 summary 6 ms；5000 个文件改动的完整状态（含行数统计）100 ms；日志首页 500 条 16 ms；2 万行文件差异 12 ms。均在 specs/07 第 5 节目标内（状态 < 300 ms、日志首页 < 500 ms、2 万行差异 < 1 s）。启动时间与 5000 文件树的滚动流畅度需要在真机上测。

M2 集成测试覆盖 specs/08 的验收项：

- main 配置 origin（主）+ github + 一个不可达目标，同步后 origin 与 github 提交一致，不可达目标失败不影响另两个。
- 设置 primary 后 `branch.main.remote/merge` 同步更新；命令行改动 upstream 后映射显示不一致；删除 remote 后规则目标标记缺失。
- 构造 UU、AA、DU 三类冲突，分别用三栏结果、接受对方、接受我方解决后完成合并提交（两个父提交）。
- rebase 3 个提交连续冲突，逐轮解决并继续，最终完成。
- 另覆盖：通配规则 + `${branch}` 模板、新建远端分支、只执行双向目标的一个方向、cherry-pick 冲突后提交、日志分页与搜索、Revert / Reset / 标签、Remote 增删改与连通性测试。

尚未验证：macOS / Windows 上的编译与打包、应用窗口实际运行与界面交互（尤其是拖拽、部分提交勾选、图片对比、快捷键）、系统钥匙串读写、回收站、在外部打开、签名与公证流程。

## 已知限制

- `pnpm-lock.yaml` 需首次 `pnpm install` 后生成并提交，CI 使用 `--frozen-lockfile`。`src-tauri/Cargo.lock` 已提交（tauri 2.12.5）。
- 签名与公证：CI 已配置，在仓库 secrets 中填入证书后自动签名（macOS Developer ID + notarytool 公证，Windows Authenticode），未填时产出未签名包。需要的 secrets 列表见 `.github/workflows/build.yml` 顶部注释。证书需要自行申请（Apple Developer Program；Windows 推荐 EV 或云端签名证书以避免 SmartScreen 信誉积累期）。
- 快捷键为固定的 JetBrains 键位（设置 › 快捷键 可查看），暂不支持自定义。
- 部分提交的选择只在本次运行中保留，重启应用后恢复为整文件勾选。
