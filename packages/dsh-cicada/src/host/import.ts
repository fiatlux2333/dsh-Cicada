import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configurationSchema, defaults } from '../shared/config.ts';
import type { ImportPreview } from '../shared/types.ts';
import { windowsCall } from './windows.ts';

export async function readLegacy(
  directory = join(process.env.APPDATA ?? '', 'Cicada'),
): Promise<ImportPreview> {
  const raw: unknown = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('旧配置格式无效');
  const data = raw as Record<string, unknown>,
    config = defaults();
  const sensitive = async (key: string): Promise<string[]> => {
    let value = data[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && '__dpapi__' in value) {
      const token = (value as { __dpapi__: unknown }).__dpapi__;
      if (typeof token !== 'string') throw new Error('旧密文格式无效');
      value = JSON.parse((await windowsCall<{ text: string }>('unprotect', { text: token })).text);
    }
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
      throw new Error('旧敏感字段无效或解密失败');
    return value.map((x) => x.trim()).filter(Boolean);
  };
  config.targets = {
    folders: await sensitive('folders_to_shred'),
    apps: await sensitive('apps_to_uninstall'),
    keywords: await sensitive('sensitive_keywords'),
  };
  if (data.levels && typeof data.levels === 'object')
    config.levels = ['L1_days', 'L2_days', 'L3_days', 'L4_days'].map(
      (k) => (data.levels as Record<string, number>)[k]!,
    );
  const mappings = {
    fake_history: 'fakeHistory',
    clear_browsing: 'clearBrowsing',
    clean_cookies: 'cleanCookies',
    shred_folders: 'shredFolders',
    clean_traces: 'cleanTraces',
    clean_event_logs: 'cleanEventLogs',
    uninstall_apps: 'uninstallApps',
  } as const;
  if (data.actions && typeof data.actions === 'object')
    for (const [old, current] of Object.entries(mappings)) {
      const value = (data.actions as Record<string, unknown>)[old];
      if (value !== undefined) {
        if (typeof value !== 'boolean') throw new Error('旧动作开关无效');
        config.actions[current] = value;
      }
    }
  if (data.browsers && typeof data.browsers === 'object')
    for (const id of ['chrome', 'edge'] as const) {
      const value = (data.browsers as Record<string, unknown>)[id];
      if (value !== undefined) {
        if (typeof value !== 'boolean') throw new Error('旧浏览器开关无效');
        config.browsers[id] = value;
      }
    }
  if (data.persona !== undefined) config.persona = configurationSchema.shape.persona.parse(data.persona);
  if (typeof data.reminder_hour === 'number') config.reminderHour = data.reminder_hour;
  if (typeof data.reminder_enabled === 'boolean') config.reminderEnabled = data.reminder_enabled;
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw new Error('旧状态文件无效');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('旧状态文件无效');
  const timestamp = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('旧时间格式无效');
    return Date.parse(value);
  };
  const executed = state.executed_levels;
  if (
    executed !== undefined &&
    (!Array.isArray(executed) || executed.some((x) => typeof x !== 'string' || !/^L[1-4]$/.test(x)))
  )
    throw new Error('旧等级记录无效');
  return {
    config: configurationSchema.parse(config),
    lastCheckin: timestamp(state.last_checkin ?? state.last_activity),
    pausedUntil: timestamp(state.paused_until),
    executedLevels: ((executed as string[] | undefined) ?? []).map((s) => Number(s.slice(1))),
    warnings: [
      '导入后为演练模式，自动触发关闭；不会修改旧数据。',
      '旧版等级无法区分演练或真实执行，导入后需在运行日志中逐级核查，核查前禁止真实执行。',
      '请勿同时启用旧程序和插件的真实自动动作。',
    ],
  };
}
