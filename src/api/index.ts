// typed invoke 封装。命令名与参数名必须与 src-tauri/src/commands.rs 保持一致
// （Tauri 会把 Rust 的 snake_case 参数映射为 JS 侧 camelCase）。
import { Channel, invoke } from '@tauri-apps/api/core';
import type * as T from './types';

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

export const api = {
  files: {
    list: (repoId: string, path: string) => call<T.DirectoryListing>('files_list', { repoId, path }),
    read: (repoId: string, path: string) => call<T.FileDocument>('files_read', { repoId, path }),
    save: (repoId: string, path: string, revision: string, text: string) => call<T.FileDocument>('files_save', { repoId, path, revision, text }),
  },
  terminal: {
    ack: (id: string, count: number) => call<void>('terminal_ack', { id, count }),
    open: (repoId: string, id: string, cols: number, rows: number, onEvent: (event: T.TerminalEvent) => void) => {
      const channel = new Channel<T.TerminalEvent>();
      channel.onmessage = onEvent;
      return call<void>('terminal_open', { repoId, id, cols, rows, onEvent: channel });
    },
    input: (id: string, data: string) => call<void>('terminal_input', { id, data }),
    resize: (id: string, cols: number, rows: number) => call<void>('terminal_resize', { id, cols, rows }),
    close: (id: string) => call<void>('terminal_close', { id }),
  },
  app: {
    setDirty: (dirty: boolean) => call<void>('app_set_dirty', { dirty }),
    exit: () => call<void>('app_exit'),
    info: () => call<T.AppInfo>('app_info'),
    setGitPath: (path: string | null) => call<T.GitInfo>('git_set_path', { path }),
  },
  settings: {
    getAll: () => call<Record<string, string>>('settings_get_all'),
    set: (key: string, value: string) => call<void>('settings_set', { key, value }),
  },
  log: {
    list: () => call<T.CommandLogEntry[]>('command_log_list'),
    clear: () => call<void>('command_log_clear'),
  },
  repo: {
    list: () => call<T.RepoView[]>('repo_list'),
    summary: (repoId: string) => call<T.RepoSummary>('repo_summary', { repoId }),
    checkPath: (path: string) => call<T.PathCheck>('repo_check_path', { path }),
    add: (path: string, init: boolean, name?: string | null) => call<T.RepoView>('repo_add', { path, init, name: name?.trim() || null }),
    remove: (repoId: string) => call<void>('repo_remove', { repoId }),
    rename: (repoId: string, name: string) => call<void>('repo_rename', { repoId, name }),
    setFavorite: (repoId: string, favorite: boolean) => call<void>('repo_set_favorite', { repoId, favorite }),
    setWatch: (repoId: string, enabled: boolean) => call<void>('repo_set_watch', { repoId, enabled }),
  },
  status: {
    get: (repoId: string) => call<T.StatusResult>('status_get', { repoId }),
  },
  checked: {
    get: (repoId: string) => call<Record<string, boolean>>('checked_get', { repoId }),
    set: (repoId: string, entries: Record<string, boolean>, keep?: string[]) =>
      call<void>('checked_set', { repoId, entries, keep: keep ?? null }),
  },
  diff: {
    file: (repoId: string, path: string, oldPath: string | null, left: T.Rev, right: T.Rev, opts: T.DiffOpts) =>
      call<T.FileDiff>('diff_file', { repoId, path, oldPath, left, right, opts }),
    writeWorktree: (repoId: string, path: string, content: string) =>
      call<void>('worktree_write', { repoId, path, content }),
  },
  commit: {
    create: (repoId: string, req: T.CommitRequest) => call<T.CommitResult>('commit_create', { repoId, req }),
    messages: (repoId: string) => call<string[]>('commit_messages', { repoId }),
    headMessage: (repoId: string) => call<string | null>('commit_head_message', { repoId }),
    mergeMessage: (repoId: string) => call<string | null>('commit_merge_message', { repoId }),
  },
  changes: {
    rollback: (repoId: string, paths: string[], opts: T.RollbackOpts) =>
      call<T.RollbackResult>('changes_rollback', { repoId, paths, opts }),
    add: (repoId: string, paths: string[]) => call<void>('changes_add', { repoId, paths }),
    ignore: (repoId: string, paths: string[], target: T.IgnoreTarget) =>
      call<void>('changes_ignore', { repoId, paths, target }),
  },
  branch: {
    list: (repoId: string) => call<T.BranchInfo[]>('branch_list', { repoId }),
    create: (repoId: string, req: T.CreateBranchReq) => call<void>('branch_create', { repoId, req }),
    checkout: (repoId: string, name: string, mode: T.CheckoutMode) =>
      call<T.CheckoutResult>('branch_checkout', { repoId, name, mode }),
    checkoutRemote: (repoId: string, remote: string, remoteBranch: string, localName?: string | null) =>
      call<string>('branch_checkout_remote', { repoId, remote, remoteBranch, localName: localName ?? null }),
    rename: (repoId: string, oldName: string, newName: string) =>
      call<void>('branch_rename', { repoId, old: oldName, new: newName }),
    delete: (repoId: string, req: T.DeleteBranchReq) => call<void>('branch_delete', { repoId, req }),
    deleteRemote: (repoId: string, remote: string, branch: string) =>
      call<void>('branch_delete_remote', { repoId, remote, branch }),
    integrate: (repoId: string, target: string, mode: T.IntegrateMode) =>
      call<T.IntegrateResult>('branch_integrate', { repoId, target, mode }),
    setUpstream: (repoId: string, local: string, remote: string | null, remoteBranch: string | null) =>
      call<void>('branch_set_upstream', { repoId, local, remote, remoteBranch }),
  },
  operation: {
    action: (repoId: string, action: T.OperationAction) =>
      call<T.IntegrateResult>('operation_action', { repoId, action }),
  },
  remote: {
    list: (repoId: string) => call<T.RemoteInfo[]>('remote_list', { repoId }),
    pushPreview: (repoId: string, branch?: string | null, remote?: string | null, remoteBranch?: string | null) =>
      call<T.PushPreview>('push_preview', {
        repoId,
        branch: branch ?? null,
        remote: remote ?? null,
        remoteBranch: remoteBranch ?? null,
      }),
  },
  identity: {
    get: (repoId: string | null, scope: T.ConfigScope) => call<T.Identity>('identity_get', { repoId, scope }),
    set: (repoId: string | null, scope: T.ConfigScope, identity: T.Identity) =>
      call<void>('identity_set', { repoId, scope, identity }),
  },
  sshKeys: {
    directory: () => call<string>('ssh_keys_directory'),
    list: () => call<T.SshKeyInfo[]>('ssh_keys_list'),
    generate: (input: T.SshKeyGenerate) => call<T.SshKeyInfo>('ssh_keys_generate', { input }),
    readPublic: (path: string) => call<T.SshKeyInfo>('ssh_keys_read_public', { path }),
  },
  auth: {
    pending: () => call<T.AuthChallenge[]>('auth_pending'),
    respond: (response: T.AuthResponse) => call<void>('auth_respond', { ...response }),
    cancel: (id: string) => call<void>('auth_cancel', { id }),
  },
  credential: {
    list: () => call<T.CredentialProfile[]>('credential_list'),
    upsert: (input: T.CredentialInput) => call<T.CredentialProfile>('credential_upsert', { input }),
    remove: (id: string) => call<void>('credential_remove', { id }),
    save: (url: string, username: string, secret: string) =>
      call<void>('credential_save', { url, username, secret }),
    delete: (url: string) => call<void>('credential_delete', { url }),
    getUser: (url: string) => call<string | null>('credential_get_user', { url }),
  },
  task: {
    list: () => call<T.TaskInfo[]>('task_list'),
    cancel: (taskId: string) => call<boolean>('task_cancel', { taskId }),
    clear: () => call<void>('task_clear'),
    clone: (req: T.CloneReq) => call<string>('task_clone', { req }),
    fetch: (repoId: string, remote?: string | null) => call<string>('task_fetch', { repoId, remote: remote ?? null }),
    fetchAll: (silent = false) => call<string[]>('task_fetch_all', { silent }),
    pull: (repoId: string, strategy?: T.PullStrategy) => call<string>('task_pull', { repoId, strategy: strategy ?? null }),
    push: (repoId: string, req: T.PushReq) => call<string>('task_push', { repoId, req }),
    sync: (repoId: string, req: T.SyncRunReq) => call<string>('task_sync', { repoId, req }),
  },
  remoteAdmin: {
    add: (repoId: string, input: T.RemoteInput) => call<void>('remote_add', { repoId, input }),
    update: (repoId: string, oldName: string, input: T.RemoteInput) => call<void>('remote_update', { repoId, oldName, input }),
    remove: (repoId: string, name: string) => call<void>('remote_remove', { repoId, name }),
    test: (repoId: string, name: string) => call<T.RemoteTestResult>('remote_test', { repoId, name }),
  },
  sync: {
    rules: (repoId: string) => call<T.SyncRule[]>('sync_rules', { repoId }),
    upsert: (repoId: string, rule: T.SyncRule) => call<T.RuleSaved>('sync_rule_upsert', { repoId, rule }),
    delete: (ruleId: string) => call<void>('sync_rule_delete', { ruleId }),
    mapping: (repoId: string) => call<T.BranchMapping[]>('sync_mapping', { repoId }),
    resolveUpstream: (repoId: string, branchName: string, prefer: 'git' | 'rule') =>
      call<void>('sync_resolve_upstream', { repoId, branchName, prefer }),
  },
  conflict: {
    context: (repoId: string) => call<T.ConflictContext>('conflict_context', { repoId }),
    load: (repoId: string, path: string) => call<T.MergeData>('conflict_load', { repoId, path }),
    accept: (repoId: string, paths: string[], side: 'ours' | 'theirs') => call<void>('conflict_accept', { repoId, paths, side }),
    resolve: (repoId: string, path: string, content: string | null) => call<void>('conflict_resolve', { repoId, path, content }),
  },
  history: {
    page: (repoId: string, query: T.LogQuery) => call<T.LogPage>('log_page', { repoId, query }),
    detail: (repoId: string, hash: string) => call<T.CommitDetail>('log_detail', { repoId, hash }),
    reset: (repoId: string, hash: string, mode: T.ResetMode) => call<void>('log_reset', { repoId, hash, mode }),
    revert: (repoId: string, hash: string) => call<T.IntegrateResult>('log_revert', { repoId, hash }),
    cherryPick: (repoId: string, hash: string) => call<T.IntegrateResult>('log_cherry_pick', { repoId, hash }),
    createTag: (repoId: string, name: string, hash: string, message: string | null) =>
      call<void>('log_create_tag', { repoId, name, hash, message }),
    fileHistory: (repoId: string, path: string, skip = 0) =>
      call<T.FileHistoryPage>('log_file_history', { repoId, path, skip }),
    blame: (repoId: string, path: string, rev: string | null) => call<T.BlameResult>('log_blame', { repoId, path, rev }),
  },
  // ---------- M3 ----------
  stash: {
    list: (repoId: string) => call<T.StashEntry[]>('stash_list', { repoId }),
    files: (repoId: string, hash: string) => call<T.StashFile[]>('stash_files', { repoId, hash }),
    create: (repoId: string, req: T.StashCreateReq) => call<void>('stash_create', { repoId, req }),
    apply: (repoId: string, hash: string, pop: boolean, restoreIndex = false) =>
      call<T.IntegrateResult>('stash_apply', { repoId, hash, pop, restoreIndex }),
    drop: (repoId: string, hash: string) => call<void>('stash_drop', { repoId, hash }),
    branch: (repoId: string, hash: string, name: string) => call<void>('stash_branch', { repoId, hash, name }),
  },
  changelist: {
    list: (repoId: string) => call<T.Changelist[]>('changelist_list', { repoId }),
    create: (repoId: string, name: string) => call<T.Changelist>('changelist_create', { repoId, name }),
    rename: (id: string, name: string) => call<void>('changelist_rename', { id, name }),
    delete: (repoId: string, id: string) => call<void>('changelist_delete', { repoId, id }),
    setActive: (repoId: string, id: string) => call<void>('changelist_set_active', { repoId, id }),
    move: (repoId: string, id: string, paths: string[]) => call<void>('changelist_move', { repoId, id, paths }),
  },
  group: {
    list: () => call<T.RepoGroup[]>('group_list'),
    create: (name: string) => call<T.RepoGroup>('group_create', { name }),
    rename: (id: string, name: string) => call<void>('group_rename', { id, name }),
    delete: (id: string) => call<void>('group_delete', { id }),
    reorder: (ids: string[]) => call<void>('group_reorder', { ids }),
    setCollapsed: (id: string, collapsed: boolean) => call<void>('group_set_collapsed', { id, collapsed }),
    moveRepos: (groupId: string | null, orderedIds: string[]) => call<void>('repo_move', { groupId, orderedIds }),
    setRepoGroup: (repoId: string, groupId: string | null) => call<void>('repo_set_group', { repoId, groupId }),
  },
  scan: {
    run: (path: string, depth: number) => call<T.ScanResult>('repo_scan', { path, depth }),
    addMany: (paths: string[], groupId: string | null) => call<T.ImportResult>('repo_add_many', { paths, groupId }),
  },
  external: {
    open: (repoId: string, rel: string | null, target: T.OpenTarget) => call<void>('open_external', { repoId, rel, target }),
  },
  compare: {
    refs: (repoId: string, left: string, right: string) => call<T.RefCompare>('compare_refs', { repoId, left, right }),
    files: (repoId: string, left: string, right: string | null) => call<T.CommitFile[]>('compare_files', { repoId, left, right }),
    blob: (repoId: string, rev: string | null, path: string) => call<T.BlobData>('blob_data', { repoId, rev, path }),
  },
  tag: {
    list: (repoId: string) => call<T.TagInfo[]>('tag_list', { repoId }),
    delete: (repoId: string, name: string) => call<void>('tag_delete', { repoId, name }),
    push: (repoId: string, remote: string, name: string | null) => call<string>('task_tag_push', { repoId, remote, name }),
    deleteRemote: (repoId: string, remote: string, name: string) =>
      call<string>('task_tag_delete_remote', { repoId, remote, name }),
  },
  precheck: {
    run: (repoId: string, paths: string[]) => call<T.PrecheckIssue[]>('commit_precheck', { repoId, paths }),
  },
  health: {
    remotes: (repoId: string) => call<T.RemoteHealth[]>('remote_check_all', { repoId }),
  },
};

export type Api = typeof api;
export * from './types';
