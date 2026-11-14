// Browser-only fixture. No real files are read or changed.
window.isTauri = true;
window.__fileCalls = [];
const entries = new Map([
  ['src', { directory: true }], ['src/example.ts', { text: 'export const greeting = "Hello GitManagement";\n' }],
  ['README.md', { text: '# GitManagement\n\n文件编辑与管理预览\n' }],
]);
let revision = 1;
const callbacks = new Map();
const terminals = new Map();
let repos = [
  { id: 'preview', name: 'GitManagement', path: '/preview/gitmanagement', groupId: 'work', missing: false, watching: false, favorite: false, sort: 0 },
  { id: 'child', name: '子仓库示例', path: '/preview/gitmanagement/services/api', groupId: 'work', missing: false, watching: false, favorite: true, sort: 1 },
  { id: 'other', name: '其他仓库', path: '/preview/other', groupId: null, missing: false, watching: false, favorite: false, sort: 2 },
];
const branches = ['main', 'feat/batch-remove', 'feat/file-management', 'fix/layout', 'origin/main', 'origin/feat/batch-remove', 'origin/feat/file-management'].map((name) => {
  const remote = name.startsWith('origin/');
  return { name, fullRef: `refs/${remote ? 'remotes' : 'heads'}/${name}`, kind: remote ? 'remote' : 'local', remote: remote ? 'origin' : null, remoteBranch: remote ? name.slice(7) : null, oid: 'a'.repeat(40), isHead: name === 'main', upstream: null, ahead: 0, behind: 0, committerTime: 0, subject: 'Preview branch' };
});
window.__TAURI_INTERNALS__ = {
  transformCallback: (callback) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
  unregisterCallback: (id) => callbacks.delete(id),
  invoke: async (cmd, args = {}) => {
    window.__fileCalls.push({ cmd, args });
    const entry = entries.get(args.path);
    const doc = (item) => ({ text: item.text, revision: String(item.revision ?? 1), size: new TextEncoder().encode(item.text).length, eol: 'LF', bom: false, readOnly: null });
    switch (cmd) {
      case 'settings_get_all': return { language: 'zh-CN', theme: 'dark', lastRepo: 'preview' };
      case 'app_info': return { appVersion: '0.1.5', platform: 'macos', git: { ok: true, version: '2.50', minVersion: '2.30' } };
      case 'repo_list': return repos;
      case 'repo_remove': repos = repos.filter((repo) => repo.id !== args.repoId); return null;
      case 'group_list': return [{ id: 'work', name: '开发项目', collapsed: false, sort: 0 }];
      case 'branch_list': return branches;
      case 'remote_list': return [{ name: 'origin', fetchUrl: 'https://example.invalid/repo.git', pushUrl: null }];
      case 'tag_list': return [{ name: 'v0.1.5', commit: 'a'.repeat(40), annotated: false, time: 0, subject: '' }];
      case 'repo_summary': return { branch: 'main', ahead: 0, behind: 0, changes: 0, conflicts: 0, operation: null };
      case 'status_get': return { branch: { head: 'main', oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 }, files: [], operation: null };
      case 'checked_get': return {};
      case 'files_list': return { entries: [...entries].filter(([path]) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === args.path).map(([path, item]) => ({ path, name: path.split('/').pop(), directory: !!item.directory, symlink: false })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)), truncated: false };
      case 'files_read': if (!entry || entry.directory) throw { code: 'files.notFile' }; return doc(entry);
      case 'files_save':
        if (String(entry.revision ?? 1) !== args.revision) throw { code: 'files.conflict' };
        entry.text = args.text; entry.revision = ++revision; return doc(entry);
      case 'files_create':
        if (entry) throw { code: 'files.exists' };
        entries.set(args.path, args.directory ? { directory: true } : { text: '', revision: ++revision }); return null;
      case 'files_rename':
        if (entries.has(args.newPath)) throw { code: 'files.exists' };
        if (!entry) throw { code: 'files.notFile' };
        for (const [path, value] of [...entries]) if (path === args.path || path.startsWith(args.path + '/')) { entries.delete(path); entries.set(args.newPath + path.slice(args.path.length), value); }
        return null;
      case 'files_delete':
        if (!entry) throw { code: 'files.notFile' };
        if ([...entries.keys()].some(path => path.startsWith(args.path + '/'))) throw { code: 'files.notEmpty' };
        entries.delete(args.path); return null;
      case 'terminal_open': {
        const send = (text) => args.onEvent.onmessage({ type: 'data', data: [...new TextEncoder().encode(text)] });
        terminals.set(args.id, { send, channel: args.onEvent });
        send('\x1b[36mGitManagement\x1b[0m  /preview/gitmanagement\r\n\x1b[32m❯\x1b[0m ');
        return null;
      }
      case 'terminal_input': {
        const terminal = terminals.get(args.id);
        if (args.data.trim() === 'exit') { terminal?.channel.onmessage({ type: 'exit', code: 0 }); return null; }
        terminal?.send(args.data.replace(/\r/g, '\r\n❯ ')); return null;
      }
      case 'terminal_close': terminals.delete(args.id); return null;
      case 'plugin:event|listen': return callbacks.size;
      default: return /(_list|_messages|_rules|_mapping)$/.test(cmd) ? [] : null;
    }
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
