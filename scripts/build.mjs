import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const pkg = new URL('packages/dsh-cicada/', root);
const shared = ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', 'react-dom'];
await mkdir(new URL('lib/', pkg), { recursive: true });
await copyFile(new URL('THIRD_PARTY_NOTICES.md', root), new URL('THIRD_PARTY_NOTICES.md', pkg));
await build({
  entryPoints: [new URL('src/host/index.ts', pkg).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  outfile: new URL('lib/index.js', pkg).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: [new URL('src/shared/types.ts', pkg).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  outfile: new URL('lib/types.js', pkg).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  platform: 'neutral',
  format: 'esm',
});
const result = await build({
  entryPoints: [new URL('src/client/index.tsx', pkg).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: shared,
  minify: true,
});
const code = result.outputFiles[0].text;
const externals = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
const baseline = new Set(['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', 'react-dom']);
const nonBaseline = [...new Set(externals.filter((name) => !baseline.has(name)))];
if (nonBaseline.length) throw new Error(`Unexpected client runtime externals: ${nonBaseline.join(', ')}`);
await writeFile(
  new URL('lib/client.js', pkg),
  `window.__ModuleLoader__.load({id:"dsh-cicada",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`,
);
console.log(
  `Built Host, strict Remote contracts, and lazy-CJS Client (${nonBaseline.join(', ') || 'baseline modules only'}).`,
);
