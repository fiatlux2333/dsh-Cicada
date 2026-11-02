import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const file = resolve('dist/dsh-cicada-0.1.0.tgz');
const names = execFileSync('tar', ['-tf', file], { encoding: 'utf8', windowsHide: true })
  .trim()
  .split(/\r?\n/);
for (const required of [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'windows/bridge.ps1',
  'cordis.patch.yml',
  'README.md',
])
  assert(names.includes(`package/${required}`), `Missing ${required}`);
assert(
  !names.some((name) => /node_modules|artifacts\/|\.env$|\.bak$|\.exe$|build-contracts|tests\//.test(name)),
);
const manifest = JSON.parse(
  execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8', windowsHide: true }),
);
assert.equal(manifest.engines.dsh, '=0.2.1-rc.5');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
for (const entry of [
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'windows/bridge.ps1',
]) {
  const packed = execFileSync('tar', ['-xOf', file, `package/${entry}`], { windowsHide: true });
  assert.deepEqual(
    packed,
    await readFile(resolve('packages/dsh-cicada', entry)),
    `Stale package entry: ${entry}`,
  );
}
const client = execFileSync('tar', ['-xOf', file, 'package/lib/client.js'], {
  encoding: 'utf8',
  windowsHide: true,
});
assert(client.startsWith('window.__ModuleLoader__.load({id:"dsh-cicada",factory:'));
const requests = [...new Set([...client.matchAll(/require\("([^\"]+)"\)/g)].map((m) => m[1]))];
assert(
  requests.every((id) => ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'].includes(id)),
);
const sha256 = createHash('sha256')
  .update(await readFile(file))
  .digest('hex');
await mkdir('dist', { recursive: true });
await writeFile('dist/SHA256SUMS.txt', `${sha256}  dsh-cicada-0.1.0.tgz\n`);
console.log(
  JSON.stringify({ package: manifest.name, files: names.length, sharedRequests: requests, sha256 }, null, 2),
);
