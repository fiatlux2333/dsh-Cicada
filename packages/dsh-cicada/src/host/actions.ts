import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { ActionRunner } from './engine.ts';
import type { Configuration, Level, StepResult } from '../shared/types.ts';
import { dripHistory, generateHistory } from '../shared/history.ts';
import { browserProfiles, cleanCookiesAndCache, modifyHistory } from './browser.ts';
import { protectedReason, shredFolder } from './folders.ts';
import { windowsCall } from './windows.ts';

export function matchApp(target: string, names: string[]): string | null {
  if (!target.trim()) return null;
  const exact = names.filter((n) => n.toLocaleLowerCase() === target.toLocaleLowerCase());
  if (exact.length) return exact[0]!;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = '[\\p{L}\\p{N}\\p{M}\\p{Pc}]';
  const pattern = new RegExp(`(?<!${word})${escaped}(?!${word})`, 'iu');
  const matches = [...new Set(names.filter((n) => pattern.test(n)))];
  if (matches.length > 1) throw new Error('Ambiguous app identity');
  return matches[0] ?? null;
}
export class WindowsActions implements ActionRunner {
  constructor(
    private readonly protectedRoots: string[],
    private readonly now: () => number = Date.now,
  ) {}
  async run(config: Configuration, level: Level, live: boolean): Promise<StepResult[]> {
    const out: StepResult[] = [];
    const step = async (
      action: string,
      enabled: boolean,
      count: number,
      fn: () => Promise<number>,
    ): Promise<void> => {
      if (!enabled) {
        out.push({ action, status: 'skipped', count: 0, detail: '已禁用' });
        return;
      }
      if (!live) {
        out.push({
          action,
          status: 'completed',
          count,
          detail: '演练：仅生成执行计划，未读取或修改真实目标',
        });
        return;
      }
      try {
        out.push({ action, status: 'completed', count: await fn(), detail: '已完成' });
      } catch {
        out.push({
          action,
          status: 'failed',
          count: 0,
          detail: '执行失败，可能存在权限、占用、路径保护或兼容性问题；恢复备份如有则保留',
        });
      }
    };
    if (level === 1 || level === 2) {
      const enabled = Object.entries(config.browsers)
        .filter(([, v]) => v)
        .map(([k]) => k as 'chrome' | 'edge');
      const shouldRun = level === 1 ? config.actions.clearBrowsing : config.actions.fakeHistory;
      if (level === 1 && !config.actions.clearBrowsing)
        out.push({
          action: 'browser',
          status: 'skipped',
          count: 0,
          detail: 'L1 浏览清理已禁用，补位随之跳过',
        });
      for (const browser of enabled)
        await step(`${browser}/L${level}`, shouldRun, 0, async () => {
          const root = join(
            process.env.LOCALAPPDATA ?? '',
            browser === 'chrome' ? 'Google/Chrome/User Data' : 'Microsoft/Edge/User Data',
          );
          const profiles = await browserProfiles(root);
          if (!profiles.length) {
            out.push({ action: browser, status: 'skipped', count: 0, detail: '未找到浏览器配置' });
            return 0;
          }
          await windowsCall('close-browser', { browser });
          const visits = !config.actions.fakeHistory
            ? []
            : level === 1
              ? generateHistory(
                  config.persona,
                  14,
                  this.now(),
                  randomInt(0x7fffffff),
                  config.targets.keywords,
                )
              : dripHistory(config.persona, this.now(), randomInt(0x7fffffff), config.targets.keywords);
          let count = 0;
          for (const profile of profiles) {
            const result = await modifyHistory(
              join(profile, 'History'),
              level === 1 ? config.targets.keywords : null,
              visits,
            );
            if (!result.backupRemoved) throw new Error('Backup retained');
            count += result.cleared + result.inserted;
            if (level === 1 && config.actions.cleanCookies) count += await cleanCookiesAndCache(profile);
          }
          return count;
        });
    }
    if (level === 3) {
      for (let i = 0; i < config.targets.folders.length; i++) {
        const target = config.targets.folders[i]!;
        if (protectedReason(target, this.protectedRoots))
          out.push({ action: `folder#${i + 1}`, status: 'failed', count: 0, detail: '命中保护清单，已拒绝' });
        else
          await step(`folder#${i + 1}`, config.actions.shredFolders, 1, async () => {
            const result = await shredFolder(target, this.protectedRoots);
            if (result.failed) throw new Error('Partial shred');
            return result.count;
          });
      }
      await step('traces', config.actions.cleanTraces, 0, async () => {
        const result = await windowsCall<{ ok: boolean; count: number }>('traces', {});
        if (!result.ok) throw new Error('Partial cleanup');
        return result.count;
      });
      await step('event-logs', config.actions.cleanEventLogs, 0, async () => {
        const result = await windowsCall<{ ok: boolean }>('events', {});
        if (!result.ok) throw new Error('Permission denied');
        return 2;
      });
    }
    if (level === 4) {
      let names: string[] = [];
      if (live && config.actions.uninstallApps && config.targets.apps.length)
        names = (await windowsCall<{ names: string[] }>('apps', {})).names;
      for (let i = 0; i < config.targets.apps.length; i++)
        await step(`app#${i + 1}`, config.actions.uninstallApps, 1, async () => {
          const name = matchApp(config.targets.apps[i]!, names) ?? config.targets.apps[i]!;
          if (/deepseek harness|dsh-cicada|cicada/i.test(name)) throw new Error('Protected application');
          const result = await windowsCall<{ ok: boolean }>('uninstall', { name }, 930000);
          if (!result.ok) throw new Error('Uninstall failed');
          return 1;
        });
    }
    return out;
  }
}
