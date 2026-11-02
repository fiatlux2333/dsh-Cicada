import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLegacy } from '../packages/dsh-cicada/src/host/import.ts';
import * as windows from '../packages/dsh-cicada/src/host/windows.ts';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(config: object, state?: object) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cicada-import-'));
  directories.push(path);
  await writeFile(join(path, 'config.json'), JSON.stringify(config));
  if (state) await writeFile(join(path, 'state.json'), JSON.stringify(state));
  return path;
}
describe('read-only legacy import', () => {
  it('maps the original format and preserves bytes', async () => {
    const path = await fixture(
      {
        dry_run: false,
        auto_trigger: true,
        levels: { L1_days: 1, L2_days: 2, L3_days: 3, L4_days: 4 },
        folders_to_shred: ['C:\\fixture'],
        sensitive_keywords: ['fixture'],
        persona: 'student',
      },
      { last_activity: '2026-10-01T00:00:00+08:00', executed_levels: ['L1'], paused_until: null },
    );
    const before = await readFile(join(path, 'config.json'));
    const preview = await readLegacy(path);
    expect(preview.config).toMatchObject({
      dryRun: true,
      autoTrigger: false,
      persona: 'student',
      levels: [1, 2, 3, 4],
    });
    expect(preview.lastCheckin).toBe(Date.parse('2026-10-01T00:00:00+08:00'));
    expect(preview.executedLevels).toEqual([1]);
    expect(await readFile(join(path, 'config.json'))).toEqual(before);
  });
  it('refuses invalid encrypted targets instead of importing empty keywords', async () => {
    const path = await fixture({ sensitive_keywords: { __dpapi__: 'bad-fixture' } });
    vi.spyOn(windows, 'windowsCall').mockRejectedValue(new Error('fixture DPAPI failure'));
    await expect(readLegacy(path)).rejects.toThrow();
  });
  it('decrypts legacy DPAPI JSON through the fixed helper contract', async () => {
    const path = await fixture({ sensitive_keywords: { __dpapi__: 'fixture-token' } });
    const call = vi.spyOn(windows, 'windowsCall').mockResolvedValue({ text: '["fixture"]' });
    expect((await readLegacy(path)).config.targets.keywords).toEqual(['fixture']);
    expect(call).toHaveBeenCalledWith('unprotect', { text: 'fixture-token' });
  });
  it('refuses corrupt timestamps and thresholds', async () => {
    const path = await fixture({}, { last_checkin: 123 });
    await expect(readLegacy(path)).rejects.toThrow();
    const invalid = await fixture({ levels: { L1_days: 7, L2_days: 7, L3_days: 14, L4_days: 30 } });
    await expect(readLegacy(invalid)).rejects.toThrow();
  });
  it.each([true, false])('never infers execution provenance from current dry_run=%s', async (dry_run) => {
    const path = await fixture({ dry_run }, { executed_levels: ['L1', 'L2'] });
    const preview = await readLegacy(path);
    expect(preview.executedLevels).toEqual([1, 2]);
    expect(preview.warnings.join(' ')).toContain('无法区分演练或真实执行');
    expect(preview.config).toMatchObject({ dryRun: true, autoTrigger: false });
  });
});
