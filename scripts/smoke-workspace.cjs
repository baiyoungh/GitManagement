const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__calls = [];
    window.__docs = {};
    window.__events = {};
    window.__repos = ['a', 'b'].map(id => ({ id, name: `Repository ${id.toUpperCase()}`, path: `/workspace/${id}`, missing: false, watching: true, favorite: false, sort: 0 }));
    window.__emit = (name, payload) => Object.values(window.__events).filter(e => e.name === name).forEach(e => e.callback({ event: name, payload }));
    let callbackId = 0;
    let eventId = 0;
    const callbacks = {};
    const terminals = {};
    const original = { text: 'original\n', revision: 'v1', size: 9, eol: 'CRLF', bom: true, readOnly: null };
    const file = { path: 'src/long.ts', origPath: null, kind: 'modified', indexStatus: '.', worktreeStatus: 'M', staged: false, unstaged: true, conflict: null, submodule: false, added: 1, removed: 1 };
    const old = "const message = 'old';\n";
    const next = "const message = '" + '中\tlong_content_'.repeat(150) + "END';\n";
    window.__TAURI_INTERNALS__ = {
      transformCallback: (callback) => { const id = ++callbackId; callbacks[id] = callback; return id; },
      unregisterCallback: (id) => { delete callbacks[id]; },
      invoke: async (cmd, args) => {
        window.__calls.push({ cmd, args });
        switch (cmd) {
          case 'settings_get_all': return { language: 'zh-CN', lastRepo: 'a', theme: 'light' };
          case 'app_info': return { appVersion: '0.1.2', platform: 'macos', git: { ok: true, version: '2.50', minVersion: '2.30' } };
          case 'repo_list': return structuredClone(window.__repos);
          case 'repo_rename': window.__repos.find(r => r.id === args.repoId).name = args.name; return null;
          case 'repo_scan': return { repos: [
            { path: '/workspace/a', name: 'a', linked: false, registered: true },
            { path: '/workspace/a/services/child', name: 'child', linked: true, registered: window.__repos.some(r => r.id === 'child') },
          ], truncated: false };
          case 'repo_add': {
            const added = { id: 'child', path: args.path, name: 'child', missing: false, watching: true, favorite: false, sort: 0 };
            window.__repos.push(added); return added;
          }
          case 'branch_list': return [false, true].map(remote => ({
            name: remote ? 'origin/feature' : 'main', fullRef: remote ? 'refs/remotes/origin/feature' : 'refs/heads/main', kind: remote ? 'remote' : 'local',
            remote: remote ? 'origin' : null, remoteBranch: remote ? 'feature' : null, oid: 'a'.repeat(40), isHead: !remote, upstream: null, ahead: 0, behind: 0,
          }));
          case 'repo_summary': return { branch: 'main', detached: false, headShort: 'aaaaaaa', ahead: 0, behind: 0, changes: 1, conflicts: 0, operation: null, lastCommitTime: 1793220000 };
          case 'status_get': return { branch: { head: 'main', oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 }, files: [file], operation: null, rebaseStep: null };
          case 'checked_get': return {};
          case 'diff_file': return { path: file.path, oldPath: null, old: { exists: true, size: old.length, text: old, eol: 'lf' }, new: { exists: true, size: next.length, text: next, eol: 'lf' }, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }], binary: false, tooLarge: false };
          case 'files_list': return { entries: args.path ? [{ name: 'long.ts', path: 'src/long.ts', directory: false, symlink: false }] : [
            { name: 'src', path: 'src', directory: true, symlink: false }, { name: 'README.md', path: 'README.md', directory: false, symlink: false },
            { name: 'binary.dat', path: 'binary.dat', directory: false, symlink: false }, { name: 'link', path: 'link', directory: false, symlink: true },
          ], truncated: false };
          case 'files_read': {
            const key = args.repoId + '/' + args.path;
            return window.__docs[key] ??= args.path === 'binary.dat' ? { ...original, text: null, readOnly: 'binary' } : { ...original };
          }
          case 'files_save': {
            const key = args.repoId + '/' + args.path;
            if (args.revision !== window.__docs[key].revision) throw { code: 'files.conflict' };
            return window.__docs[key] = { ...window.__docs[key], text: args.text, revision: String(Date.now()), size: args.text.length };
          }
          case 'terminal_open': {
            const terminal = terminals[args.id] = { channel: args.onEvent, index: 0, repoId: args.repoId };
            terminal.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(`/workspace/${args.repoId}\r\n$ `)) });
            return null;
          }
          case 'terminal_input': {
            const terminal = terminals[args.id];
            terminal?.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(args.data)) });
            return null;
          }
          case 'plugin:event|listen': {
            const id = ++eventId; window.__events[id] = { name: args.event, callback: callbacks[args.handler] }; return id;
          }
          case 'plugin:event|unlisten': delete window.__events[args.eventId]; return null;
          default: return cmd.endsWith('_list') || cmd.endsWith('_messages') || cmd.endsWith('_rules') || cmd.endsWith('_mapping') ? [] : null;
        }
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  try {
    await page.goto(process.env.SMOKE_BASE_URL || 'http://localhost:1420');
    await page.getByRole('button', { name: '重命名 Repository A', exact: true }).click();
    await page.getByRole('textbox', { name: '显示名称' }).fill('主项目 · 本地别名');
    const confirm = page.getByRole('button', { name: '确定', exact: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const hover of [false, true]) {
        if (hover) await confirm.hover(); else await page.mouse.move(0, 0);
        const colors = await confirm.evaluate(e => { const c = getComputedStyle(e); return { fg: c.color, bg: c.backgroundColor }; });
        const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const a = luminance(colors.fg), b = luminance(colors.bg);
        assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${theme} primary hover=${hover}: ${JSON.stringify(colors)}`);
      }
      await page.screenshot({ path: join(tmpdir(), `gm-buttons-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await confirm.click();
    await page.locator('.repo-name', { hasText: '主项目 · 本地别名' }).waitFor();
    assert.equal(await page.locator('.repo-item').first().getAttribute('title'), '/workspace/a');
    assert.equal(await page.locator('.repo-folder').first().innerText(), 'a');
    const selected = page.locator('.repo-item.selected');
    const selectedBackground = await selected.evaluate(e => getComputedStyle(e).backgroundColor);
    await selected.hover();
    assert.equal(await selected.evaluate(e => getComputedStyle(e).backgroundColor), selectedBackground);
    await selected.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '扫描子仓库…', exact: true }).click();
    await page.getByRole('spinbutton').fill('4');
    await page.getByRole('button', { name: '扫描', exact: true }).click();
    await page.getByText('子仓库', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.__calls.some(c => c.cmd === 'repo_scan' && c.args.path === '/workspace/a' && c.args.depth === 4)));
    assert.equal(await page.locator('.scan-list input:disabled').count(), 1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.branch-chip').click();
    await page.locator('.branch-family-row', { hasText: 'child' }).click();
    await page.getByRole('button', { name: 'feature', exact: true }).click();
    await page.screenshot({ path: join(tmpdir(), 'gm-nested-desktop.png') });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.screenshot({ path: join(tmpdir(), 'gm-nested-minimum.png') });
    assert.ok(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.getByRole('menuitem', { name: '从「origin/feature」新建分支…', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some(c => c.cmd === 'branch_list' && c.args.repoId === 'child'));
    assert.ok(await page.evaluate(() => window.__calls.some(c => c.cmd === 'repo_add' && c.args.path === '/workspace/a/services/child')));
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.getByText('long.ts', { exact: true }).click();
    await page.locator('.diff-row').first().waitFor();
    for (const mode of ['并排', '统一']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      const scroller = mode === '并排' ? '.diff-side-x' : '.diff-scroll';
      await page.waitForFunction(selector => document.querySelector(selector).scrollWidth > document.querySelector(selector).clientWidth * 2, scroller);
      if (mode === '并排') {
        assert.ok(await page.locator('.diff-row.side .code').nth(1).evaluate(e => e.getBoundingClientRect().left < innerWidth));
        assert.ok(await page.locator('.diff-scroll').evaluate(e => e.scrollWidth === e.clientWidth));
        await page.locator(scroller).focus();
        await page.keyboard.press('End');
        await page.waitForFunction(() => parseFloat(document.querySelector('.diff-scroll').style.getPropertyValue('--diff-offset')) < -100);
        await page.keyboard.press('Home');
      }
      const before = await page.locator(scroller).evaluate(e => { const before = e.scrollLeft; e.scrollLeft = e.scrollWidth; return before; });
      assert.equal(before, 0);
      assert.ok(await page.locator(scroller).evaluate(e => e.scrollLeft > 1000));
      await page.screenshot({ path: join(tmpdir(), `gm-scroll-${mode === '并排' ? 'side' : 'unified'}.png`) });
      await page.locator(scroller).evaluate(e => { e.scrollLeft = 0; });
    }
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('edited in UI\n');
    assert.ok(await page.getByRole('tab', { name: 'README.md *', exact: true }).count());
    await page.getByRole('treeitem', { name: 'src', exact: true }).click();
    await page.getByRole('treeitem', { name: 'long.ts', exact: true }).click();
    await page.getByRole('tab', { name: 'README.md *', exact: true }).click();
    assert.match(await editor.innerText(), /edited in UI/);
    await page.getByRole('tab', { name: '变更', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    assert.match(await editor.innerText(), /edited in UI/);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.__docs['a/README.md'].text.includes('edited in UI'));
    assert.ok(await page.getByRole('button', { name: '保存', exact: true }).isDisabled());
    await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('dirty conflict\n');
    await page.evaluate(() => { window.__docs['a/README.md'] = { ...window.__docs['a/README.md'], revision: 'external', text: 'external change\n' }; });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText(/文件已被其他程序修改/).waitFor();
    assert.match(await editor.innerText(), /dirty conflict/);
    assert.equal(await page.evaluate(() => window.__docs['a/README.md'].text), 'external change\n');
    await page.evaluate(() => window.__emit('app-close-requested'));
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.cmd === 'app_exit').length), 0);
    await page.getByRole('treeitem', { name: 'binary.dat', exact: true }).click();
    await page.getByText('二进制或非 UTF-8 文件，请使用外部编辑器。').waitFor();
    assert.equal(await page.locator('.cm-editor').count(), 0);
    assert.ok(await page.getByRole('treeitem', { name: 'link', exact: true }).isDisabled());
    await page.locator('.topbar').getByRole('button', { name: '终端', exact: true }).click();
    await page.locator('.terminal-pane:not([hidden]) .xterm').waitFor();
    await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').fill('');
    await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();
    await page.keyboard.type('pwd'); await page.keyboard.press('Enter');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    assert.equal(await page.getByRole('tab', { name: '文件', exact: true }).getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => window.__calls.some(c => c.cmd === 'terminal_input' && c.args.data.includes('p')));
    const initialOpens = await page.evaluate(() => window.__calls.filter(c => c.cmd === 'terminal_open').length);
    await page.getByRole('button', { name: '收起', exact: true }).last().click();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.cmd === 'terminal_close').length), initialOpens - 1);
    await page.locator('.topbar').getByRole('button', { name: '终端', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => c.cmd === 'terminal_open').length), initialOpens);
    await page.evaluate(async () => { const { useApp } = await import('/src/stores/appStore.ts'); useApp.getState().selectRepo('b'); });
    await page.waitForFunction(() => window.__calls.some(c => c.cmd === 'terminal_open' && c.args.repoId === 'b'));
    await page.evaluate(async () => { const { useApp } = await import('/src/stores/appStore.ts'); useApp.getState().selectRepo('a'); });
    await page.getByRole('tab', { name: 'README.md *', exact: true }).click();
    assert.match(await editor.innerText(), /dirty conflict/);
    await page.screenshot({ path: join(tmpdir(), 'gm-workspace-desktop.png') });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.screenshot({ path: join(tmpdir(), 'gm-workspace-minimum.png') });
    assert.ok(await page.locator('.terminal-host').first().evaluate(e => e.clientHeight > 20));
    assert.ok(await page.locator('.code-editor').evaluate(e => e.clientHeight > 20));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: light/dark primary hover contrast, alias/folder layout, nested scan/import/branch targeting, side/unified horizontal scroll, file editing/save, dirty/conflict/quit protection, terminal lifecycle/isolation, 1440x950 and 960x600 layouts');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
