import type { Context } from '@deepseek-ai/cordis';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-commands';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { documentSchema } from '../shared/config.ts';
import { CicadaEngine } from './engine.ts';
import { CicadaService } from './service.ts';
import { WindowsActions } from './actions.ts';
import { acquireMonitor, windowsSecrets } from './windows.ts';
import type { Document, Persona } from '../shared/types.ts';
export { CicadaService } from './service.ts';
export type * from '../shared/types.ts';

export const name: string = 'cicada';
export const inject: string[] = ['storageDomain', 'tools', 'commands'];

export async function apply(ctx: Context): Promise<void> {
  const lock = await acquireMonitor();
  let engine: CicadaEngine | undefined;
  let closeDomain: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer);
    try {
      await engine?.close();
    } finally {
      try {
        await closeDomain?.();
      } finally {
        await lock.release();
      }
    }
  };
  try {
    ctx.effect(() => dispose);
  } catch (error) {
    await lock.release();
    throw error;
  }
  try {
    const domain = await ctx.storageDomain.open(
      defineDomain({
        name: 'cicada',
        version: 1,
        global: {
          schema: z.object({ document: documentSchema.nullable() }),
          initial: { document: null as Document | null },
        },
        tables: {},
      }),
    );
    if (disposed) {
      await domain.close();
      throw new Error('Cicada disposed while opening storage');
    }
    closeDomain = () => domain.close();
    const active = new CicadaEngine({
      repository: {
        load: async () => domain.global.get().document,
        save: async (document) => {
          await domain.global.set({ document });
        },
      },
      secrets: windowsSecrets,
      runner: new WindowsActions([
        resolve(fileURLToPath(new URL('../../', import.meta.url))),
        dirname(process.execPath),
        resolveDshHome(),
        resolve(process.env.APPDATA ?? homedir(), 'Cicada'),
      ]),
      writable: lock.acquired,
      lease: lock.alive,
    });
    engine = active;
    await active.initialize();
    if (disposed) {
      await active.close();
      throw new Error('Cicada disposed while initializing');
    }
    new CicadaService(ctx, active);
    timer = setInterval(() => {
      active.tick().catch(() => {
        ctx.logger.error('Cicada persistence/evaluation failed; monitoring stopped');
        void active.close().catch(() => {});
      });
    }, 60000);
    ctx.commands.register({
      name: 'cicada',
      description: 'Cicada 打卡、状态、暂停和演练',
      recordInput: false,
      input: { hint: 'status | checkin | pause 1|4|8|24 | resume | drill | open' },
      async handler(invocation) {
        invocation.signal.throwIfAborted();
        try {
          const [verb = 'status', argument, ...rest] = invocation.rawInput.trim().split(/\s+/);
          if (rest.length || (argument && verb !== 'pause')) throw new Error('命令参数无效');
          if (verb === 'checkin') await active.checkin();
          else if (verb === 'pause') await active.pause(Number(argument));
          else if (verb === 'resume') await active.resume();
          else if (verb === 'drill') await active.drill();
          else if (verb === 'open') return { kind: 'success', text: 'Cicada 管理页已请求打开。' };
          else if (verb !== 'status')
            throw new Error('支持 status / checkin / pause / resume / drill / open');
          const s = active.status();
          return {
            kind: 'success',
            text: `Cicada · L${s.level} · 沉默 ${s.silenceDays.toFixed(2)} 天 · ${s.dryRun ? '演练' : '真实'} · 自动触发${s.autoTrigger ? '开启' : '关闭'}${s.blocked ? `\n${s.blocked}` : ''}`,
          };
        } catch {
          return {
            kind: 'error',
            text: 'Cicada 命令未完成。请检查参数和管理页状态；支持 status、checkin、pause 1|4|8|24、resume、drill、open。',
          };
        }
      },
    });
    ctx.tools.register(
      defineTool({
        name: 'cicada_status',
        description: 'Read redacted Cicada watchdog status. Does not check in or modify configuration.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        execute: async (_args, exec) => {
          exec.signal.throwIfAborted();
          return JSON.stringify(active.status());
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: 'cicada_preview_history',
        description: 'Preview synthetic browsing history. Does not read or write real browser data.',
        parameters: {
          persona: {
            type: 'string',
            enum: ['worker', 'student', 'designer', 'trader', 'gamer', 'lifestyle'],
            required: true,
          },
          days: { type: 'integer', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted();
          return JSON.stringify(active.preview(args.persona as Persona, args.days).slice(0, 100));
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: 'cicada_drill',
        description:
          'Queue a dry-run plan only. Never closes browsers, deletes files, changes rules, checks in, or runs uninstallers.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (_args, exec) => {
          exec.signal.throwIfAborted();
          await active.drill();
          return 'Cicada dry-run queued. No real operations are authorized.';
        },
      }),
    );
    await active.tick();
  } catch (error) {
    await dispose();
    throw error;
  }
}
