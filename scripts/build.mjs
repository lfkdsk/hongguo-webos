import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'app');
const service = resolve(root, 'service');
const dist = resolve(root, 'dist');

for (const required of [resolve(app, 'icon.png'), resolve(app, 'vendor/webOSTV.js'), resolve(service, 'ffmpeg'), resolve(service, 'node_modules/openhongguo')]) {
  if (!existsSync(required)) throw new Error(`Missing build input: ${required}`);
}
// openhongguo's Go runtime is a side-effect script. On the TV's Node 20.12,
// require() cannot load its .js file from an ESM package; .cjs preserves it.
const sdk = resolve(service, 'node_modules/openhongguo');
const sdkEntry = resolve(sdk, 'index.js');
const sdkSource = readFileSync(sdkEntry, 'utf8');
if (sdkSource.includes("'wasm_exec.js'")) {
  copyFileSync(resolve(sdk, 'dist/wasm_exec.js'), resolve(sdk, 'dist/wasm_exec.cjs'));
  writeFileSync(sdkEntry, sdkSource.replace("'wasm_exec.js'", "'wasm_exec.cjs'"));
}
mkdirSync(dist, { recursive: true });
const result = spawnSync('ares-package', [app, service, '-o', dist, '--no-minify'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

