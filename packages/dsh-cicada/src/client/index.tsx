import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js';
import { CicadaApp } from './App.tsx';
import { CicadaReminder } from './Reminder.tsx';
import type { CicadaClient } from './api.ts';
import styles from './style.css';

export const inject = ['remote', 'slots', 'pluginNavigation', 'commandUi'];
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => {
    const element = document.createElement('style');
    element.dataset.cicada = 'true';
    element.textContent = styles;
    document.head.append(element);
    return () => element.remove();
  });
  await ctx.remote.$mount(TYPERT_REMOTE);
  ctx.inject(['remote.cicada'], (ctx) => {
    const remote = ctx.remote.cicada;
    const api: CicadaClient = {
      view: async () => unwrap(await remote.view()),
      checkin: async () => unwrap(await remote.checkin()),
      pause: async (hours) => unwrap(await remote.pause(hours)),
      resume: async () => unwrap(await remote.resume()),
      save: async (request) => unwrap(await remote.save(request)),
      safeMode: async () => unwrap(await remote.safeMode()),
      stopAutomation: async () => unwrap(await remote.stopAutomation()),
      prepare: async (kind) => unwrap(await remote.prepare(kind)),
      confirm: async (request) => unwrap(await remote.confirm(request)),
      drill: async () => unwrap(await remote.drill()),
      preview: async (persona, days) => unwrap(await remote.preview(persona, days)),
      importPreview: async () => unwrap(await remote.importPreview()),
      prepareImport: async () => unwrap(await remote.prepareImport()),
      resolveInterrupted: async (id, phrase) => unwrap(await remote.resolveInterrupted(id, phrase)),
      resolveLegacy: async (level, mode, phrase, expectedRevision) =>
        unwrap(await remote.resolveLegacy(level, mode, phrase, expectedRevision)),
    };
    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-cicada' }, () => <CicadaApp api={api} />),
    );
    const open = (): void => ctx.pluginNavigation.openBundle('dsh-cicada');
    const status = async () => unwrap(await remote.status());
    ctx.on('command/executed', (_sessionId, name, result) => {
      if (name === 'cicada' && result.kind === 'success' && result.text === 'Cicada 管理页已请求打开。')
        open();
    });
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'cicada.reminder' }, () => (
        <CicadaReminder status={status} open={open} />
      )),
    );
  });
}
