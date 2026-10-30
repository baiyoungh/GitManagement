const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

try {
  const pkg = readJson('package.json');
  const config = readJson('src-tauri/tauri.conf.json');
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--locked', '--no-deps', '--format-version', '1',
    '--manifest-path', 'src-tauri/Cargo.toml',
  ], { cwd: root, encoding: 'utf8' }));
  const manifest = path.join(root, 'src-tauri/Cargo.toml');
  const rust = metadata.packages.find((entry) => path.resolve(entry.manifest_path) === manifest);
  if (!rust || pkg.version !== rust.version || pkg.version !== config.version) {
    throw new Error(`Version mismatch: package.json=${pkg.version}, Cargo.toml=${rust?.version}, tauri.conf.json=${config.version}`);
  }
  if (!existsSync(path.join(root, `docs/releases/v${pkg.version}.md`))) {
    throw new Error(`Missing release notes: docs/releases/v${pkg.version}.md`);
  }
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) {
    throw new Error(`Tag ${process.env.GITHUB_REF_NAME} does not match v${pkg.version}`);
  }
  console.log(`Release metadata OK: v${pkg.version}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
