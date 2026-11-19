import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { auditManifests, CORE, GENERATOR, isDsh } from './check-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginPath = 'packages/dsh-cicada/package.json';
const STORAGE = '@deepseek-ai/dsh-storage-domain';

function exactTarget(target) {
  if (!target || semver.valid(target) !== target)
    throw new Error('Supply an exact DSH version, e.g. 0.2.2-rc.1');
}

export function candidateManifests(workspace, plugin, target, officialGenerator, storage) {
  exactTarget(target);
  const coreRange = officialGenerator.peerDependencies?.[CORE];
  if (
    officialGenerator.name !== GENERATOR ||
    officialGenerator.version !== target ||
    !coreRange ||
    !semver.validRange(coreRange)
  )
    throw new Error('Official generator metadata must identify the target and its Cordis peer range');
  const zod = storage.dependencies?.zod;
  if (storage.name !== STORAGE || storage.version !== target || !semver.valid(zod))
    throw new Error('Official storage SDK must identify the target and its exact Zod schema version');
  workspace = structuredClone(workspace);
  plugin = structuredClone(plugin);
  workspace.devDependencies[GENERATOR] = target;
  for (const dependencies of [plugin.peerDependencies, plugin.devDependencies]) {
    for (const name of Object.keys(dependencies)) {
      if (isDsh(name)) dependencies[name] = target;
    }
    dependencies[CORE] = coreRange;
  }
  plugin.dependencies.zod = zod;
  plugin.engines.dsh = '=' + target;
  plugin.version = semver.inc(plugin.version, 'patch') + '-compat.' + target;
  plugin.cicadaCompatibilityProbe = true;
  auditManifests(workspace, plugin, target);
  return { workspace, plugin };
}

async function officialManifest(name, target) {
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + target, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Could not read ${name}@${target}: HTTP ${response.status}`);
  return response.json();
}

async function prepare(target) {
  exactTarget(target);
  const [generator, storage] = await Promise.all([
    officialManifest(GENERATOR, target),
    officialManifest(STORAGE, target),
  ]);
  const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const candidate = candidateManifests(read('package.json'), read(pluginPath), target, generator, storage);

  // Use a fresh checkout-shaped directory. This also isolates concurrent probes and failed installs.
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'dev',
      'scripts',
      'tests',
      'packages/dsh-cicada',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      ':(top,glob)tsconfig*.json',
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'index.html',
      'THIRD_PARTY_NOTICES.md',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const directory = mkdtempSync(join(root, 'artifacts', 'compat-'));
  for (const file of files) {
    const dest = join(directory, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, file), dest);
  }
  const write = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n');
  write('package.json', candidate.workspace);
  write(pluginPath, candidate.plugin);

  // No user-controlled arguments enter the Windows shell. Use the project's pinned pnpm.
  const args = ['install', '--no-frozen-lockfile', '--registry=https://registry.npmjs.org'];
  console.error('Preparing DSH ' + target + ' in ' + directory);
  execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
    process.platform === 'win32' ? ['/d', '/c', 'pnpm', ...args] : args,
    { cwd: directory, stdio: ['ignore', 2, 2] },
  );
  execFileSync(process.execPath, ['scripts/check-compatibility.mjs', '--host-version', target], {
    cwd: directory,
    stdio: ['ignore', 2, 2],
  });
  console.log(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: pnpm compat:prepare <exact-dsh-version>');
  await prepare(process.argv[2]);
}
