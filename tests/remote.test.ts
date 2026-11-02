import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CicadaEngine } from '../packages/dsh-cicada/src/host/engine.ts';
import { CicadaService } from '../packages/dsh-cicada/src/host/service.ts';
import { TYPERT } from '../packages/dsh-cicada/lib/typert.host.js';
import type { Document } from '../packages/dsh-cicada/src/shared/types.ts';

const requirePackage = createRequire(resolve('packages/dsh-cicada/package.json'));
const load = async (name: string) => import(pathToFileURL(requirePackage.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
const { TypertGatewayService } = await load('@deepseek-ai/dsh-api-gateway');
const contexts: InstanceType<typeof Context>[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});
async function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  const registry = new TypertRegistry(ctx);
  registry.register(TYPERT);
  // Business access is additionally checked even when a carrier's policy permits a guest.
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  const gateway = new TypertGatewayService(ctx, {});
  let stored: Document | null = null;
  const engine = new CicadaEngine({
    repository: {
      load: async () => stored,
      save: async (d) => {
        stored = structuredClone(d);
      },
    },
    secrets: { protect: async (t) => JSON.stringify(t), unprotect: async (t) => JSON.parse(t) },
    runner: { run: async () => [] },
    writable: true,
  });
  await engine.initialize();
  new CicadaService(ctx, engine);
  const peer = {
    id: 'owner-fixture',
    ctx,
    principal: { kind: 'owner' },
    signal: new AbortController().signal,
    interactions: 'none',
    dispose: async () => {},
  };
  const call = (method: string, args: Record<string, unknown> = {}, guest = false) =>
    gateway.invoke({
      namespace: 'cicada',
      method,
      args,
      peer: guest ? { ...peer, principal: { kind: 'fixture-guest' } } : peer,
    });
  return { call, registry, engine };
}
describe('official strict Remote dispatch', () => {
  it('registers generated strict definitions rather than SRC fallback', async () => {
    const f = await fixture();
    expect(f.registry.local.list().length).toBeGreaterThan(10);
    expect(
      f.registry.local.list().every((d: { result: { mode: string } }) => d.result.mode === 'strict'),
    ).toBe(true);
    const value = await f.call('status');
    expect(value).toMatchObject({ dryRun: true, autoTrigger: false });
  });
  it('rejects unknown fields and wrong primitive types before business execution', async () => {
    const f = await fixture();
    await expect(f.call('pause', { hours: '4' })).rejects.toThrow();
    await expect(f.call('status', { path: 'C:\\private' })).rejects.toThrow();
    await expect(f.call('pause', { hours: 4, confirm: true })).rejects.toThrow();
    expect(f.engine.status().pausedUntil).toBeNull();
  });
  it('rejects guest callers for status, sensitive configuration and dangerous methods', async () => {
    const f = await fixture();
    for (const [method, args] of [
      ['status', {}],
      ['view', {}],
      ['prepare', { kind: 'execute' }],
      ['checkin', {}],
      ['stopAutomation', {}],
      ['resolveLegacy', { level: 1, mode: 'drill', phrase: '已核查仅为演练', expectedRevision: 0 }],
    ] as const)
      await expect(f.call(method, args, true)).rejects.toThrow();
  });
  it('accepts only the fixed confirmation enum and no arbitrary operation', async () => {
    const f = await fixture();
    await expect(f.call('prepare', { kind: 'uninstall' })).rejects.toThrow();
    await expect(f.call('shell', { command: 'ignored' })).rejects.toThrow();
    expect(f.engine.view().runs).toHaveLength(0);
  });
  it('requires GUI challenge and phrase, not a boolean confirmation', async () => {
    const f = await fixture();
    await expect(f.call('confirm', { request: { confirm: true } })).rejects.toThrow();
    const confirmation = await f.call('prepare', { kind: 'live' });
    await expect(
      f.call('confirm', { request: { token: confirmation.token, phrase: 'yes' } }),
    ).rejects.toThrow();
    expect(f.engine.status().dryRun).toBe(true);
  });
  it('strictly validates the stop and legacy-review contracts', async () => {
    const f = await fixture();
    await expect(f.call('stopAutomation', { enable: true })).rejects.toThrow();
    await expect(
      f.call('resolveLegacy', { level: 1, mode: 'unknown', phrase: '', expectedRevision: 0 }),
    ).rejects.toThrow();
    await expect(
      f.call('resolveLegacy', { level: '1', mode: 'drill', phrase: '', expectedRevision: 0 }),
    ).rejects.toThrow();
    await expect(
      f.call('resolveLegacy', { level: 1, mode: 'drill', confirm: true, expectedRevision: 0 }),
    ).rejects.toThrow();
    const view = await f.call('stopAutomation');
    expect(view.status).toMatchObject({ autoTrigger: false, authorized: false });
    expect(view.legacyLevels).toEqual([]);
  });
  it('returns pending legacy records and persists only an explicitly reviewed mode', async () => {
    const f = await fixture();
    const confirmation = f.engine.prepare('import', 'fixture', {
      config: f.engine.view().config,
      lastCheckin: null,
      pausedUntil: null,
      executedLevels: [1],
      warnings: [],
    });
    await f.engine.confirm({ token: confirmation.token, phrase: '我确认' }, 'fixture');
    await f.engine.idle();
    const before = await f.call('view');
    expect(before.legacyLevels).toEqual([1]);
    const reviewed = await f.call('resolveLegacy', {
      level: 1,
      mode: 'drill',
      phrase: '已核查仅为演练',
      expectedRevision: before.status.revision,
    });
    expect(reviewed.legacyLevels).toEqual([]);
    expect(reviewed.runs[0]).toMatchObject({ source: 'legacy', mode: 'drill', state: 'completed' });
    expect(reviewed.status).toMatchObject({ autoTrigger: false, authorized: false });
  });
});
