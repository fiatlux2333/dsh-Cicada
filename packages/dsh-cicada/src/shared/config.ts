import { z } from 'zod';
import type { Configuration, Document, Settings, Targets } from './types.ts';

export const personaSchema = z.enum(['worker', 'student', 'designer', 'trader', 'gamer', 'lifestyle']);
export const settingsSchema = z
  .object({
    dryRun: z.boolean(),
    autoTrigger: z.boolean(),
    levels: z
      .array(z.number().finite().positive())
      .length(4)
      .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), '阈值必须严格递增'),
    actions: z
      .object({
        fakeHistory: z.boolean(),
        clearBrowsing: z.boolean(),
        cleanCookies: z.boolean(),
        shredFolders: z.boolean(),
        cleanTraces: z.boolean(),
        cleanEventLogs: z.boolean(),
        uninstallApps: z.boolean(),
      })
      .strict(),
    browsers: z.object({ chrome: z.boolean(), edge: z.boolean() }).strict(),
    persona: personaSchema,
    reminderEnabled: z.boolean(),
    reminderHour: z.number().int().min(0).max(23),
  })
  .strict();
export const targetsSchema = z
  .object({
    folders: z.array(z.string().trim().min(1).max(32760)).max(100),
    apps: z.array(z.string().trim().min(1).max(256)).max(100),
    keywords: z.array(z.string().trim().min(1).max(256)).max(100),
  })
  .strict();
export const configurationSchema = settingsSchema.extend({ targets: targetsSchema }).strict();
export const stepSchema = z.object({
  action: z.string(),
  status: z.enum(['completed', 'skipped', 'failed']),
  count: z.number().nonnegative(),
  detail: z.string(),
});
export const runSchema = z.object({
  id: z.string(),
  cycle: z.string(),
  revision: z.number().int(),
  level: z.number().int().min(1).max(4),
  mode: z.enum(['drill', 'live']),
  state: z.enum(['pending', 'started', 'completed', 'failed', 'interrupted', 'cancelled']),
  source: z.enum(['manual', 'automatic', 'legacy']).default('automatic'),
  createdAt: z.number().finite(),
  finishedAt: z.number().finite().nullable(),
  steps: z.array(stepSchema),
});
export const documentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  settings: settingsSchema,
  encryptedTargets: z.string(),
  state: z.object({
    cycle: z.string(),
    lastCheckin: z.number().finite().nonnegative(),
    pausedUntil: z.number().finite().nullable(),
    lastObserved: z.number().finite(),
    remindedOn: z.string(),
    reminderPending: z.boolean(),
    legacyLevels: z.array(z.number().int().min(1).max(4)),
  }),
  authorization: z.object({ hash: z.string(), at: z.number().finite() }).nullable(),
  runs: z.array(runSchema),
  logs: z.array(
    z.object({
      id: z.number(),
      at: z.number(),
      level: z.enum(['info', 'warning', 'error']),
      text: z.string(),
    }),
  ),
});
export function defaults(): Configuration {
  return {
    dryRun: true,
    autoTrigger: false,
    levels: [3, 7, 14, 30],
    actions: {
      fakeHistory: true,
      clearBrowsing: true,
      cleanCookies: false,
      shredFolders: true,
      cleanTraces: true,
      cleanEventLogs: false,
      uninstallApps: true,
    },
    browsers: { chrome: true, edge: true },
    persona: 'worker',
    reminderEnabled: true,
    reminderHour: 21,
    targets: { folders: [], apps: [], keywords: [] },
  };
}
export function splitConfiguration(value: Configuration): { settings: Settings; targets: Targets } {
  const { targets, ...settings } = configurationSchema.parse(value);
  return {
    settings,
    targets: {
      folders: [...new Set(targets.folders)],
      apps: [...new Set(targets.apps)],
      keywords: [...new Set(targets.keywords)],
    },
  };
}
export function freshDocument(now: number, cycle: string): Document {
  const { targets: _targets, ...settings } = defaults();
  return {
    version: 1,
    revision: 0,
    settings,
    encryptedTargets: '',
    state: {
      cycle,
      lastCheckin: now,
      pausedUntil: null,
      lastObserved: now,
      remindedOn: '',
      reminderPending: false,
      legacyLevels: [],
    },
    authorization: null,
    runs: [],
    logs: [],
  };
}
export const personaLabels: Record<string, string> = {
  worker: '程序员',
  student: '学生',
  designer: '设计师',
  trader: '投资者',
  gamer: '游戏玩家',
  lifestyle: '日常生活',
};
export const actionLabels: Record<string, string> = {
  clearBrowsing: '浏览数据清理',
  fakeHistory: '假历史补位 / 注入',
  cleanCookies: 'Cookies 与缓存',
  shredFolders: '文件夹粉碎',
  cleanTraces: 'Windows 使用痕迹',
  cleanEventLogs: '系统事件日志',
  uninstallApps: '指定软件卸载',
};
