import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditInstalledManifests, auditManifests } from '../scripts/check-compatibility.mjs';

const workspace = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const plugin = JSON.parse(
  readFileSync(new URL('../packages/dsh-cicada/package.json', import.meta.url), 'utf8'),
);
const target = workspace.devDependencies['@deepseek-ai/dsh-typert-generator'];
const core = '@deepseek-ai/cordis';
const generator = '@deepseek-ai/dsh-typert-generator';

function installedFixture(coreVersion = '4.1.0') {
  const cordis = { name: core, version: coreVersion };
  const manifests: Record<string, Record<string, any>> = {
    workspace: {
      [generator]: {
        name: generator,
        version: target,
        peerDependencies: { [core]: '~4.1.0' },
      },
    },
    plugin: { [core]: cordis },
    [generator]: { [core]: cordis },
  };
  for (const name of Object.keys(plugin.devDependencies))
    if (name.startsWith('@deepseek-ai/dsh-')) {
      manifests.plugin![name] = {
        name,
        version: target,
        peerDependencies: { [core]: '~4.1.0' },
      };
      manifests[name] = { [core]: cordis };
    }
  return {
    manifests,
    load: (scope: string, name: string) => {
      const manifest = manifests[scope]?.[name];
      if (!manifest) throw new Error(`Fixture dependency missing: ${scope}/${name}`);
      return manifest;
    },
  };
}

describe('Harness compatibility preflight', () => {
  it('keeps generator, peer SDKs, development SDKs and the engine on one target', () => {
    expect(auditManifests(workspace, plugin, target).sdkVersion).toBe(target);
  });
  it.each(['0.2.1-rc.5', '0.2.2-rc.2', '0.2.2', '0.3.0', 'invalid'])(
    'rejects untested Host %s rather than silently widening the RC range',
    (version) => {
      expect(() => auditManifests(workspace, plugin, version)).toThrow('not supported');
    },
  );
  it('rejects a stale SDK even if engines.dsh matches', () => {
    const changed = structuredClone(plugin);
    changed.peerDependencies['@deepseek-ai/dsh-commands'] = '0.2.1-rc.5';
    expect(() => auditManifests(workspace, changed, target)).toThrow('expected');
  });
  it('rejects a missing development copy of a shared peer', () => {
    const changed = structuredClone(plugin);
    delete changed.devDependencies['@deepseek-ai/dsh-tools'];
    expect(() => auditManifests(workspace, changed, target)).toThrow('matching');
  });
  it('rejects a wildcard engine and a floating generator', () => {
    expect(() => auditManifests(workspace, { ...plugin, engines: { dsh: '*' } }, target)).toThrow(
      'engines.dsh',
    );
    const changed = structuredClone(workspace);
    changed.devDependencies['@deepseek-ai/dsh-typert-generator'] = '^0.2.2';
    expect(() => auditManifests(changed, plugin, target)).toThrow('exact SDK');
  });
  it('checks the actual official SDK and generator Cordis peers', () => {
    expect(() => auditInstalledManifests(workspace, plugin, installedFixture().load)).not.toThrow();
  });
  it('rejects old Cordis even when the plugin and all installed SDK versions agree', () => {
    const changed = structuredClone(plugin);
    changed.peerDependencies[core] = '4.0.5';
    changed.devDependencies[core] = '4.0.5';
    expect(() => auditManifests(workspace, changed, target)).not.toThrow();
    expect(() => auditInstalledManifests(workspace, changed, installedFixture('4.0.5').load)).toThrow(
      'requires @deepseek-ai/cordis ~4.1.0',
    );
  });
  it.each([generator, '@deepseek-ai/dsh-api-gateway'])(
    'rejects the installed %s peer requirement instead of trusting the plugin range',
    (name) => {
      const fixture = installedFixture();
      fixture.manifests[name === generator ? 'workspace' : 'plugin']![name].peerDependencies[core] = '~4.2.0';
      expect(() => auditInstalledManifests(workspace, plugin, fixture.load)).toThrow(
        'requires @deepseek-ai/cordis ~4.2.0',
      );
    },
  );
  it('rejects malformed official peer metadata', () => {
    const fixture = installedFixture();
    fixture.manifests.workspace![generator].peerDependencies[core] = 'invalid range';
    expect(() => auditInstalledManifests(workspace, plugin, fixture.load)).toThrow('Invalid official peer');
  });
  it.each([generator, '@deepseek-ai/dsh-api-gateway'])(
    'rejects an incompatible Core resolved by %s itself',
    (name) => {
      const fixture = installedFixture();
      fixture.manifests[name]![core] = { name: core, version: '4.0.5' };
      expect(() => auditInstalledManifests(workspace, plugin, fixture.load)).toThrow(
        'requires @deepseek-ai/cordis ~4.1.0',
      );
    },
  );
  it('rejects split shared Core versions even when both satisfy the official range', () => {
    const fixture = installedFixture();
    fixture.manifests[generator]![core] = { name: core, version: '4.1.1' };
    expect(() => auditInstalledManifests(workspace, plugin, fixture.load)).toThrow('shared Core version');
  });
  it('rejects stale installed SDK metadata without modifying any real dependencies', () => {
    const fixture = installedFixture();
    fixture.manifests.plugin!['@deepseek-ai/dsh-api-gateway'].version = '0.2.1-rc.5';
    expect(() => auditInstalledManifests(workspace, plugin, fixture.load)).toThrow('Installed');
  });
});
