import { createRoot } from 'react-dom/client';
import { CicadaApp } from '../packages/dsh-cicada/src/client/App.tsx';
import '../packages/dsh-cicada/src/client/style.css';
import { defaults } from '../packages/dsh-cicada/src/shared/config.ts';
import { generateHistory } from '../packages/dsh-cicada/src/shared/history.ts';
import type { CicadaClient } from '../packages/dsh-cicada/src/client/api.ts';
import type { View } from '../packages/dsh-cicada/src/shared/types.ts';

// Browser-only fixture: never imports Host code and has no filesystem or system bridge.
let view: View = {
  config: defaults(),
  status: {
    lastCheckin: Date.now() - 1.28 * 86400000,
    silenceDays: 1.28,
    level: 0,
    nextLevel: 1,
    remainingDays: 1.72,
    pausedUntil: null,
    dryRun: true,
    autoTrigger: false,
    authorized: false,
    busy: false,
    writable: true,
    revision: 0,
    clockWarning: false,
    secretError: false,
    reminderPending: false,
    blocked: '',
  },
  runs: [],
  legacyLevels: [],
  logs: [{ id: 1, at: Date.now(), level: 'info', text: '隔离演示数据已加载' }],
};
const clone = (): View => structuredClone(view);
const api: CicadaClient = {
  view: async () => clone(),
  checkin: async () => {
    view.status.lastCheckin = Date.now();
    view.status.silenceDays = 0;
    view.status.revision++;
    return clone();
  },
  pause: async (hours) => {
    view.status.pausedUntil = Date.now() + hours * 3600000;
    return clone();
  },
  resume: async () => {
    view.status.pausedUntil = null;
    return clone();
  },
  save: async (request) => {
    if (request.expectedRevision !== view.status.revision) throw new Error('配置已变化，草稿保留');
    if (request.config.levels.some((v, i, a) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= a[i - 1]!)))
      throw new Error('阈值必须为有限正数并严格递增');
    const input = structuredClone(request.config);
    if (request.section === 'rules') {
      view.config.levels = input.levels;
      view.config.actions = input.actions;
      view.config.autoTrigger = input.autoTrigger;
      view.config.reminderEnabled = input.reminderEnabled;
      view.config.reminderHour = input.reminderHour;
      view.status.autoTrigger = input.autoTrigger;
    } else if (request.section === 'targets') {
      view.config.targets = input.targets;
      view.config.browsers = input.browsers;
    } else view.config.persona = input.persona;
    view.status.revision++;
    return clone();
  },
  safeMode: async () => {
    view.config.dryRun = true;
    view.config.autoTrigger = false;
    view.status.dryRun = true;
    view.status.autoTrigger = false;
    view.status.revision++;
    return clone();
  },
  stopAutomation: async () => {
    view.config.autoTrigger = false;
    view.status.autoTrigger = false;
    view.status.authorized = false;
    view.status.revision++;
    return clone();
  },
  prepare: async (kind) => ({
    token: 'fixture',
    kind,
    summary: '隔离预览：本页面不会执行任何系统动作。\n真实插件使用已保存目标并要求宿主人工确认。',
    expiresAt: Date.now() + 120000,
    revision: view.status.revision,
  }),
  confirm: async () => {
    throw new Error('隔离预览禁止确认真实操作');
  },
  drill: async () => {
    view.runs.unshift({
      id: crypto.randomUUID(),
      cycle: 'fixture',
      revision: 0,
      level: 1,
      mode: 'drill',
      source: 'manual',
      state: 'completed',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      steps: [],
    });
    return clone();
  },
  preview: async (persona, days) => generateHistory(persona, days, Date.now()),
  importPreview: async () => ({
    config: defaults(),
    lastCheckin: null,
    pausedUntil: null,
    executedLevels: [],
    warnings: ['隔离预览不读取旧文件'],
  }),
  prepareImport: async () => ({
    token: 'fixture',
    kind: 'import',
    summary: '隔离预览不导入真实数据。',
    expiresAt: Date.now() + 120000,
    revision: 0,
  }),
  resolveInterrupted: async () => clone(),
  resolveLegacy: async (level, mode, phrase, expectedRevision) => {
    if (
      expectedRevision !== view.status.revision ||
      !view.legacyLevels.includes(level) ||
      phrase !== (mode === 'drill' ? '已核查仅为演练' : '已核查真实执行')
    )
      throw new Error('核查确认无效');
    view.legacyLevels = view.legacyLevels.filter((value) => value !== level);
    view.config.autoTrigger = false;
    view.status.autoTrigger = false;
    view.status.authorized = false;
    view.status.revision++;
    return clone();
  },
};
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
document.body.style.cssText = `margin:0;background:${dark ? '#17191c' : '#fff'};padding:24px;`;
createRoot(document.getElementById('root')!).render(<CicadaApp api={api} />);
