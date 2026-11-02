import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator';
import { fileURLToPath } from 'node:url';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
// The official analyzer identifies decorators through its Project Reference inventory.
// Mirror published declarations only; no edits to installed dependencies or runtime code.
const source = realpathSync(
  resolve(root, 'packages/dsh-cicada/node_modules/@deepseek-ai/dsh-typert-protocol'),
);
const staging = resolve(root, 'packages/build-contracts/protocol');
mkdirSync(staging, { recursive: true });
cpSync(resolve(source, 'lib/types'), staging, { recursive: true });
writeFileSync(
  resolve(staging, 'package.json'),
  JSON.stringify({
    name: '@deepseek-ai/dsh-typert-protocol',
    private: true,
    type: 'module',
    exports: { '.': './index.d.ts' },
  }),
);
writeFileSync(
  resolve(staging, 'tsconfig.json'),
  JSON.stringify({ extends: '../../../tsconfig.base.json', include: ['**/*.d.ts'] }),
);
const modules = resolve(staging, 'node_modules');
if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
mkdirSync(resolve(modules, '@deepseek-ai'), { recursive: true });
const requireProtocol = createRequire(resolve(source, 'package.json'));
for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-brand', 'zod']) {
  const packageFile = requireProtocol.resolve(`${dependency}/package.json`);
  const link = resolve(modules, dependency);
  if (!existsSync(link)) symlinkSync(resolve(packageFile, '..'), link, 'junction');
}
const generator = new WorkspaceTypertGenerator(root);
const artifacts = generator.generateContributors(['host']);
if (!artifacts.some((a) => a.package === 'dsh-cicada'))
  throw new Error('Cicada Remote contribution was not generated');
writeWorkspaceArtifacts(root, artifacts);
console.log('Generated strict Host and Remote contracts from official Typert generator.');
