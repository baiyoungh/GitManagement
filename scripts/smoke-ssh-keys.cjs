// UI smoke with fake IPC; never generates keys in the user's actual home.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1320, height: 840 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    const callbacks = {};
    let sequence = 0;
    const keys = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { const id = ++sequence; callbacks[id] = callback; return id; }, unregisterCallback: id => delete callbacks[id],
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'settings_get_all': return { language: 'zh-CN', theme: 'light' };
          case 'app_info': return { appVersion: '0.1.5', platform: 'macos', git: { ok: true, version: '2.50', minVersion: '2.30' } };
          case 'repo_list': case 'task_list': case 'command_log_list': case 'auth_pending': return [];
          case 'ssh_keys_directory': return '/Users/example/.ssh';
          case 'ssh_keys_list': return [...keys];
          case 'ssh_keys_generate': {
            // Never retain passphrase in test state either.
            const key = { name: args.input.name, publicPath: `/Users/example/.ssh/${args.input.name}.pub`, privatePath: `/Users/example/.ssh/${args.input.name}`, publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFQBXp8Q2y7VmFfJk5rGv0XzqKLtM1n9RsW4cH6eUa2B ${args.input.comment}`, fingerprint: 'SHA256:WkHfWZQpAM/TVhO0Ha9kdMFd5xuvXyFgcN78oZUXN8k', keyType: 'ssh-ed25519', comment: args.input.comment };
            keys.push(key); return key;
          }
          case 'plugin:event|listen': return ++sequence;
          default: return null;
        }
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  try {
    await page.goto(process.env.SMOKE_BASE_URL || 'http://localhost:1422');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 密钥', exact: true }).click();
    await page.getByRole('button', { name: '生成 SSH 密钥', exact: true }).click();
    await page.getByLabel('私钥口令', { exact: true }).fill('smoke-only-phrase');
    await page.getByLabel('确认口令', { exact: true }).fill('smoke-only-phrase');
    await page.screenshot({ path: join(tmpdir(), 'gm-ssh-key-generate.png') });
    await page.getByRole('button', { name: '生成密钥对', exact: true }).click();
    const publicKey = page.getByLabel('SSH 公钥', { exact: true });
    await publicKey.waitFor();
    assert.ok((await publicKey.inputValue()).startsWith('ssh-ed25519 '));
    assert.ok(await publicKey.evaluate(e => e.getBoundingClientRect().width >= e.parentElement.getBoundingClientRect().width - 3));
    assert.equal(await page.locator('input[type=password]').count(), 0);
    await page.screenshot({ path: join(tmpdir(), 'gm-ssh-key-public.png') });
    await page.getByRole('button', { name: '查看 SSH 配置示例', exact: true }).click();
    await page.getByText(/IdentityFile/, { exact: false }).last().waitFor();
    await page.setViewportSize({ width: 960, height: 600 });
    assert.ok(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: join(tmpdir(), 'gm-ssh-key-minimum.png') });
    assert.deepEqual(errors, []);
    console.log('SSH key UI passed: generation form, masked confirmation, public-only result, config instructions, 960px layout.');
  } catch (error) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: join(tmpdir(), 'gm-ssh-key-failure.png') });
    throw error;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
