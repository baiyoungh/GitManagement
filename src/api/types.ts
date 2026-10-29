// 与 src-tauri 中 serde(rename_all = "camelCase") 的结构体一一对应

export interface AppError {
  code: string;
  params: Record<string, string>;
  detail?: string | null;
}

export interface GitInfo {
  path: string;
  version: string | null;
  ok: boolean;
  minVersion: string;
  error: AppError | null;
}

export interface AppInfo {
  appVersion: string;
  platform: string; // macos | windows | linux
  git: GitInfo;
}

export interface RepoView {
  id: string;
  path: string;
  rootCommit: string | null;
  name: string;
  groupId: string | null;
  favorite: boolean;
  sort: number;
  autoFetchMinutes: number | null;
  createdAt: number;
  missing: boolean;
  watching: boolean;
}

export type RepoOperation = 'merge' | 'rebase' | 'cherryPick' | 'revert';

export interface RepoSummary {
  branch: string | null;
  detached: boolean;
  headShort: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: number;
  conflicts: number;
  operation: RepoOperation | null;
  lastCommitTime: number | null;
}

export interface PathCheck {
  exists: boolean;
  isRepo: boolean;
  root: string | null;
  registered: boolean;
}

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

export interface FileChange {
  path: string;
  origPath: string | null;
  kind: ChangeKind;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  conflict: string | null;
  submodule: boolean;
  added: number | null;
  removed: number | null;
}

export interface BranchStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface StatusResult {
  branch: BranchStatus;
  files: FileChange[];
  operation: RepoOperation | null;
  rebaseStep: [number, number] | null;
}

export type Rev = { kind: 'worktree' } | { kind: 'index' } | { kind: 'commit'; rev: string };

export type WhitespaceMode = 'none' | 'eol' | 'all' | 'blankLines';
export type DiffAlgorithm = 'myers' | 'patience' | 'histogram';

export interface DiffOpts {
  whitespace: WhitespaceMode;
  ignoreCrAtEol: boolean;
  algorithm: DiffAlgorithm;
  force: boolean;
}

export type Eol = 'none' | 'lf' | 'crlf' | 'mixed';

export interface DiffSide {
  exists: boolean;
  size: number;
  text: string | null;
  eol: Eol;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  old: DiffSide;
  new: DiffSide;
  hunks: Hunk[];
  binary: boolean;
  tooLarge: boolean;
}

export interface CommitRequest {
  files: string[];
  message: string;
  amend: boolean;
  signoff: boolean;
  author?: string | null;
  noVerify: boolean;
  stagingMode: boolean;
  /** 部分提交（C-03） */
  partial?: PartialFile[];
}

/** 选中的 hunk；removed/added 为 null 表示该 hunk 的全部删除/新增行 */
export interface HunkSelection {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed?: number[] | null;
  added?: number[] | null;
}

export interface PartialFile {
  path: string;
  hunks: HunkSelection[];
}

export interface CommitResult {
  hash: string;
  shortHash: string;
  output: string;
}

export interface RollbackOpts {
  deleteAdded: boolean;
  deleteUntracked: boolean;
}

export interface RollbackResult {
  restored: string[];
  trashed: string[];
  skipped: string[];
}

export type IgnoreTarget = 'gitignore' | 'exclude';

export type BranchKind = 'local' | 'remote';

export interface BranchInfo {
  name: string;
  fullRef: string;
  kind: BranchKind;
  remote: string | null;
  remoteBranch: string | null;
  oid: string;
  isHead: boolean;
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  committerTime: number;
  subject: string;
}

export interface UpstreamRef {
  remote: string;
  branch: string;
}

export interface CreateBranchReq {
  name: string;
  startPoint?: string | null;
  checkout: boolean;
  upstream?: UpstreamRef | null;
}

export type CheckoutMode = 'normal' | 'smart' | 'force';

export interface CheckoutResult {
  stashConflict: boolean;
}

export interface DeleteBranchReq {
  name: string;
  force: boolean;
  remote?: UpstreamRef | null;
}

export type IntegrateMode = 'merge' | 'rebase';

export interface IntegrateResult {
  conflicts: boolean;
  output: string;
}

export type OperationAction = 'continue' | 'abort' | 'skip';

export type PullStrategy = 'merge' | 'rebase' | 'ffOnly';

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrls: string[];
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
}

export interface PushPreview {
  branch: string;
  remote: string;
  remoteBranch: string;
  newBranch: boolean;
  commits: CommitSummary[];
  behind: number;
  remotes: string[];
}

export interface PushReq {
  branch: string;
  remote: string;
  remoteBranch: string;
  force: boolean;
  tags: boolean;
  setUpstream: boolean;
}

export interface CloneReq {
  url: string;
  dest: string;
  branch?: string | null;
  depth?: number | null;
}

export type ConfigScope = 'global' | 'local';

export interface Identity {
  name: string | null;
  email: string | null;
}

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskInfo {
  id: string;
  repoId: string | null;
  kind: string;
  params: Record<string, string>;
  state: TaskState;
  percent: number | null;
  message: string;
  startedAt: number;
  error: AppError | null;
  output: string | null;
}

export interface TaskProgress {
  taskId: string;
  percent: number | null;
  message: string;
}

// ---------- M2：远端映射 ----------

export interface RemoteInput {
  name: string;
  fetchUrl: string;
  pushUrls: string[];
}

export interface RemoteTestResult {
  ok: boolean;
  heads: number;
  error: AppError | null;
}

export type SyncDirection = 'push' | 'pull' | 'both';

export interface SyncTarget {
  id: string;
  remote: string | null;
  url: string | null;
  remoteBranch: string;
  direction: SyncDirection;
  force: boolean;
  enabled: boolean;
}

export interface SyncRule {
  id: string;
  repoId: string;
  branchPattern: string;
  targets: SyncTarget[];
  primaryTargetId: string | null;
  order: number;
}

export interface RuleSaved {
  rule: SyncRule;
  upstreamUpdated: string[];
}

export interface PlannedTarget {
  targetId: string;
  ruleId: string;
  remote: string | null;
  url: string | null;
  remoteBranch: string;
  direction: SyncDirection;
  force: boolean;
  enabled: boolean;
  primary: boolean;
  remoteMissing: boolean;
  remoteBranchExists: boolean | null;
  ahead: number | null;
  behind: number | null;
}

export type UpstreamState = 'notManaged' | 'consistent' | 'mismatch';

export interface BranchMapping {
  branch: string;
  isHead: boolean;
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  ruleId: string | null;
  rulePattern: string | null;
  overriddenRuleIds: string[];
  targets: PlannedTarget[];
  upstreamState: UpstreamState;
}

export interface SyncItem {
  branch: string;
  targetId: string;
  action: 'push' | 'pull';
}

export interface SyncRunReq {
  branches: string[] | null;
  targetIds: string[] | null;
  items?: SyncItem[] | null;
  pullStrategy: PullStrategy;
  confirmedForce: string[];
}

export type TargetOutcome = 'success' | 'upToDate' | 'rejected' | 'authFailed' | 'network' | 'conflict' | 'skipped' | 'failed' | 'cancelled';

export interface TargetResult {
  branch: string;
  targetId: string;
  remote: string | null;
  url: string | null;
  remoteBranch: string;
  action: 'push' | 'pull';
  outcome: TargetOutcome;
  error: AppError | null;
}

export interface SyncReport {
  results: TargetResult[];
  conflict: boolean;
}

// ---------- M2：冲突 ----------

export interface ConflictFile {
  path: string;
  code: string;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
  binary: boolean;
}

export interface ConflictContext {
  operation: RepoOperation | null;
  oursLabel: string;
  theirsLabel: string;
  files: ConflictFile[];
}

export type BlockKind = 'unchanged' | 'ours' | 'theirs' | 'both' | 'conflict';

export interface LineRange {
  start: number;
  end: number;
}

export interface MergeBlock {
  kind: BlockKind;
  base: LineRange;
  ours: LineRange;
  theirs: LineRange;
}

export interface MergeData {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  blocks: MergeBlock[];
  worktreeEdited: boolean;
  eol: string;
}

// ---------- M2：日志 ----------

export interface LogCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  refs: string[];
}

export interface LogQuery {
  refs: string[];
  skip: number;
  limit?: number | null;
  grep?: string | null;
  author?: string | null;
  since?: string | null;
  until?: string | null;
  paths?: string[];
}

export interface LogPage {
  commits: LogCommit[];
  hasMore: boolean;
}

export interface CommitFile {
  status: string;
  path: string;
  oldPath: string | null;
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
  files: CommitFile[];
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface CommandLogEntry {
  id: number;
  cwd: string;
  command: string;
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  output: string;
}

// ======================= M3 =======================

export interface StashEntry {
  selector: string;
  index: number;
  hash: string;
  base: string;
  hasUntracked: boolean;
  message: string;
  branch: string | null;
  time: number;
}

export interface StashFile extends CommitFile {
  untracked: boolean;
}

export interface StashCreateReq {
  message: string;
  paths: string[];
  includeUntracked: boolean;
  keepIndex: boolean;
}

export interface Changelist {
  id: string;
  name: string;
  active: boolean;
  sort: number;
  files: string[];
}

export interface RepoGroup {
  id: string;
  name: string;
  sort: number;
  collapsed: boolean;
}

export interface ScanItem {
  path: string;
  name: string;
  linked: boolean;
  registered: boolean;
}

export interface ScanResult {
  repos: ScanItem[];
  truncated: boolean;
}

export interface ImportResult {
  added: RepoView[];
  failed: [string, AppError][];
}

export type OpenTarget = 'fileManager' | 'reveal' | 'terminal' | 'editor';

export interface FileHistoryEntry {
  commit: LogCommit;
  status: string;
  path: string;
  oldPath: string | null;
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  hasMore: boolean;
}

export interface BlameCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  summary: string;
  uncommitted: boolean;
}

export interface BlameLine {
  hash: string;
  origLine: number;
  content: string;
}

export interface BlameResult {
  commits: BlameCommit[];
  lines: BlameLine[];
}

export interface RefCompare {
  onlyRight: LogCommit[];
  onlyLeft: LogCommit[];
  truncated: boolean;
  files: CommitFile[];
}

export interface BlobData {
  exists: boolean;
  size: number;
  oid: string | null;
  base64: string | null;
}

export interface TagInfo {
  name: string;
  commit: string;
  annotated: boolean;
  time: number;
  subject: string;
}

export type PrecheckKind = 'largeFile' | 'secret' | 'todo';

export interface PrecheckIssue {
  kind: PrecheckKind;
  path: string;
  line: number | null;
  detail: string;
}

export interface RemoteHealth {
  name: string;
  result: RemoteTestResult;
}
