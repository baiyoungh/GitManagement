// Browser-only UI verification. All IPC is mocked; no real credential is stored.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1320, height: 840 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__calls = [];
    window.__events = {};
    window.__profiles = [{ id: 'company', name: '公司 GitLab', url: 'https://git.example.com', username: 'developer' }];
    let sequence = 0;
    const callbacks = {};
    window.__emit = (name, payload) => Object.values(window.__events).filter(e => e.name === name).forEach(e => e.callback({ event: name, payload }));
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { const id = ++sequence; callbacks[id] = callback; return id; },
      unregisterCallback: id => { delete callbacks[id]; },
      invoke: async (cmd, args) => {
        // Do not retain secret-bearing requests even in this test's browser history.
        if (!['auth_respond', 'credential_upsert'].includes(cmd)) window.__calls.push({ cmd, args });
        switch (cmd) {
          case 'settings_get_all': return { language: 'zh-CN', theme: 'light', cloneParent: '/workspace' };
          case 'app_info': return { appVersion: '0.1.5', platform: 'macos', git: { ok: true, version: '2.50', minVersion: '2.30' } };
          case 'repo_list': case 'task_list': case 'command_log_list': case 'auth_pending': return [];
          case 'credential_list': return structuredClone(window.__profiles);
          case 'credential_upsert': {
            const profile = { id: args.input.id || 'new', name: args.input.name, url: args.input.url, username: args.input.username };
            window.__profiles = [...window.__profiles.filter(p => p.id !== profile.id), profile]; return profile;
          }
          case 'auth_respond': window.__responded = { id: args.id, remember: args.remember, credentialId: args.credentialId }; window.__emit('auth-resolved', { id: args.id }); return null;
          case 'auth_cancel': window.__emit('auth-resolved', { id: args.id }); return null;
          case 'plugin:event|listen': { const id = ++sequence; window.__events[id] = { name: args.event, callback: callbacks[args.handler] }; return id; }
          case 'plugin:event|unlisten': delete window.__events[args.eventId]; return null;
          default: return null;
        }
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  try {
    await page.goto(process.env.SMOKE_BASE_URL || 'http://localhost:1420');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '凭据', exact: true }).click();
    await page.getByText('公司 GitLab', { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'gm-auth-settings.png') });
    await page.getByRole('button', { name: '添加凭据', exact: true }).click();
    await page.getByLabel('凭据名称', { exact: true }).fill('私人账号');
    await page.getByLabel('地址（如 https://gitlab.corp.com）').fill('https://git.example.com');
    await page.getByLabel('用户名', { exact: true }).fill('personal');
    await page.getByLabel('令牌 / 密码').fill('test-only-secret');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('私人账号', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /克隆/ }).first().click();
    await page.getByLabel('仓库 URL').fill('https://git.example.com/team/project.git');
    const select = page.locator('.credential-fields select');
    assert.equal(await select.locator('option').count(), 4);
    await select.selectOption('company');
    await page.screenshot({ path: join(tmpdir(), 'gm-auth-clone.png') });
    await page.setViewportSize({ width: 960, height: 600 });
    assert.ok(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '凭据', exact: true }).click();
    await page.evaluate(() => window.__emit('auth-challenge', { id: 'challenge', taskId: 'task', url: 'https://git.example.com', kind: 'https', username: null, profiles: window.__profiles, error: null, expiresAt: Date.now() + 180000 }));
    const dialog = page.getByRole('dialog', { name: '需要认证', exact: true });
    await dialog.waitFor();
    await dialog.getByLabel('用户名', { exact: true }).fill('developer');
    await dialog.getByLabel('令牌 / 密码').fill('test-only-secret');
    assert.equal(await dialog.locator('input[type=checkbox]').isChecked(), false);
    await page.screenshot({ path: join(tmpdir(), 'gm-auth-challenge.png') });
    await dialog.getByRole('button', { name: '继续', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).count(), 1);
    assert.equal((await page.evaluate(() => window.__responded)).remember, false);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    await page.evaluate(() => window.__emit('auth-challenge', { id: 'ssh-host', taskId: 'ssh-task', url: 'git@ssh.example.com', kind: 'sshHostKey', username: 'git', profiles: [], error: null, expiresAt: Date.now() + 180000, ssh: { destination: 'git@ssh.example.com', host: 'ssh.example.com', port: 2222, username: 'git', keyPath: null, keyType: 'ED25519', fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' } }));
    const trust = page.getByRole('dialog', { name: '核验 SSH 主机密钥', exact: true });
    await trust.waitFor();
    assert.equal(await trust.locator('input[type=password]').count(), 0);
    await trust.getByText('SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', { exact: true }).waitFor();
    assert.ok(await trust.evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: join(tmpdir(), 'gm-ssh-hostkey.png') });
    await trust.getByRole('button', { name: '信任主机密钥并继续', exact: true }).click();
    await trust.waitFor({ state: 'detached' });
    for (const [kind, label] of [['sshPassword', 'SSH 密码'], ['sshPassphrase', '私钥口令']]) {
      await page.evaluate(kind => window.__emit('auth-challenge', { id: kind, taskId: 'ssh-task', url: 'git@ssh.example.com', kind, username: 'git', profiles: [], error: null, expiresAt: Date.now() + 180000, ssh: { destination: 'git@ssh.example.com', host: 'ssh.example.com', port: 2222, username: 'git', keyPath: kind === 'sshPassphrase' ? '/temporary/key with spaces' : null, fingerprint: null, keyType: null } }), kind);
      const ssh = page.getByRole('dialog', { name: '需要认证', exact: true });
      await ssh.waitFor();
      await ssh.getByLabel(label, { exact: true }).fill('test-ssh-secret');
      assert.equal(await ssh.locator('input[type=checkbox]').count(), 0);
      await page.screenshot({ path: join(tmpdir(), `gm-${kind}.png`) });
      await ssh.getByRole('button', { name: '继续', exact: true }).click();
      await ssh.waitFor({ state: 'detached' });
      assert.equal((await page.evaluate(() => window.__responded)).remember, false);
    }
    assert.deepEqual(errors, []);
    console.log('Auth UI smoke passed: settings/clone/HTTP and SSH password/passphrase/host-key, explicit trust, 960px layout, no runtime errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
