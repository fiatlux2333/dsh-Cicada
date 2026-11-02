import { describe, expect, it } from 'vitest';
import {
  CicadaEngine,
  type ActionRunner,
  type Repository,
  type Secrets,
} from '../packages/dsh-cicada/src/host/engine.ts';
import { defaults, freshDocument } from '../packages/dsh-cicada/src/shared/config.ts';
import type {
  Configuration,
  Document,
  Level,
  StepResult,
  Targets,
} from '../packages/dsh-cicada/src/shared/types.ts';

const DAY = 86400000;
async function fixture(
  input: {
    document?: Document;
    writable?: boolean;
    runner?: ActionRunner;
    secrets?: Secrets;
    lease?: () => boolean;
  } = {},
) {
  let now = new Date('2026-11-02T12:00:00+08:00').getTime(),
    stored: Document | null = input.document ? structuredClone(input.document) : null,
    rejectSave = false;
  const calls: { level: Level; live: boolean; config: Configuration }[] = [];
  const repository: Repository = {
    load: async () => stored,
    save: async (d) => {
      if (rejectSave) throw new Error('disk failure');
      stored = structuredClone(d);
    },
  };
  const secrets: Secrets = input.secrets ?? {
    protect: async (t) => `encrypted:${JSON.stringify(t)}`,
    unprotect: async (t) => JSON.parse(t.slice(10)) as Targets,
  };
  const runner: ActionRunner = {
    run: async (config, level, live) => {
      calls.push({ config, level, live });
      return input.runner
        ? input.runner.run(config, level, live)
        : [{ action: 'fixture', status: 'completed', count: 1, detail: 'test substitute' }];
    },
  };
  const engine = new CicadaEngine({
    repository,
    secrets,
    runner,
    writable: input.writable ?? true,
    lease: input.lease,
    now: () => now,
  });
  await engine.initialize();
  return {
    engine,
    calls,
    advance: (days: number) => {
      now += days * DAY;
    },
    setTime: (value: number) => {
      now = value;
    },
    stored: () => stored!,
    failSave: () => {
      rejectSave = true;
    },
    restoreSave: () => {
      rejectSave = false;
    },
  };
}
async function live(engine: CicadaEngine): Promise<void> {
  const token = engine.prepare('live', 'owner');
  await engine.confirm({ token: token.token, phrase: '我确认' }, 'owner');
  await engine.idle();
}
async function authorize(engine: CicadaEngine): Promise<void> {
  const token = engine.prepare('authorize', 'owner');
  await engine.confirm({ token: token.token, phrase: '我确认' }, 'owner');
  await engine.idle();
}
async function auto(engine: CicadaEngine): Promise<void> {
  const v = engine.view();
  v.config.autoTrigger = true;
  await engine.save({ section: 'rules', config: v.config, expectedRevision: v.status.revision });
}

describe('check-in and authoritative persistence', () => {
  it('starts with an installation baseline, dry-run and automatic actions off', async () => {
    const f = await fixture();
    expect(f.engine.status()).toMatchObject({ silenceDays: 0, dryRun: true, autoTrigger: false, level: 0 });
    expect(f.stored().state.lastCheckin).toBeGreaterThan(0);
    expect(f.stored().encryptedTargets).toBe(`encrypted:${JSON.stringify(defaults().targets)}`);
    const reopened = await fixture({ document: f.stored() });
    expect(reopened.engine.status().secretError).toBe(false);
  });
  it('does not persist a new baseline if initial target encryption fails', async () => {
    let writes = 0;
    const engine = new CicadaEngine({
      repository: {
        load: async () => null,
        save: async () => {
          writes++;
        },
      },
      secrets: {
        protect: async () => {
          throw new Error('DPAPI unavailable');
        },
        unprotect: async () => defaults().targets,
      },
      runner: { run: async () => [] },
      writable: true,
    });
    await expect(engine.initialize()).rejects.toThrow('DPAPI');
    await engine.close();
    expect(writes).toBe(0);
  });
  it('counts time while stopped without ticking', async () => {
    const f = await fixture();
    f.advance(8);
    expect(f.engine.status()).toMatchObject({ level: 2, silenceDays: 8 });
  });
  it('pause does not reset elapsed time; expires and resumes', async () => {
    const f = await fixture();
    await f.engine.pause(24);
    f.advance(2);
    expect(f.engine.status().silenceDays).toBe(2);
    expect(f.engine.status().pausedUntil).toBeNull();
  });
  it.each([0, -1, 2, 100, Infinity, NaN])('rejects unsupported pause %s', async (h) => {
    const f = await fixture();
    await expect(f.engine.pause(h)).rejects.toThrow();
  });
  it('check-in creates a new cycle and resets timer and pause', async () => {
    const f = await fixture();
    const old = f.stored().state.cycle;
    f.advance(5);
    await f.engine.pause(4);
    await f.engine.checkin();
    expect(f.stored().state.cycle).not.toBe(old);
    expect(f.engine.status()).toMatchObject({ silenceDays: 0, pausedUntil: null });
  });
  it('does not publish a failed save', async () => {
    const f = await fixture();
    const old = f.engine.view();
    f.failSave();
    await expect(f.engine.checkin()).rejects.toThrow();
    expect(f.engine.view()).toEqual(old);
  });
  it('rejects invalid authoritative documents instead of resetting a dangerous timer', async () => {
    const d = freshDocument(Date.now(), 'x');
    d.state.lastCheckin = NaN;
    await expect(fixture({ document: d })).rejects.toThrow();
  });
  it('read-only instances cannot mutate or initialize storage', async () => {
    const f = await fixture({ writable: false });
    await expect(f.engine.checkin()).rejects.toThrow();
    await expect(f.engine.drill()).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it('detects clock rollback, suspends actions, recovers when clock catches up', async () => {
    const f = await fixture();
    await auto(f.engine);
    f.advance(5);
    await f.engine.tick();
    await f.engine.idle();
    f.advance(-2);
    await f.engine.tick();
    expect(f.engine.status().clockWarning).toBe(true);
    const before = f.calls.length;
    f.advance(1);
    await f.engine.tick();
    expect(f.calls).toHaveLength(before);
    await f.engine.checkin();
    expect(f.engine.status().clockWarning).toBe(false);
  });
});

describe('automatic admission and crash boundaries', () => {
  it('catches up after reopening without replaying completed levels', async () => {
    const f = await fixture();
    await auto(f.engine);
    const d = f.stored();
    d.state.lastCheckin -= 40 * DAY;
    const opened = await fixture({ document: d });
    await opened.engine.tick();
    await opened.engine.idle();
    expect(opened.calls.map((c) => c.level)).toEqual([1, 2, 3, 4]);
    const reopened = await fixture({ document: opened.stored() });
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls).toHaveLength(0);
  });
  it('admits concurrent ticks only once per level', async () => {
    const f = await fixture();
    await auto(f.engine);
    f.advance(40);
    await Promise.all(Array.from({ length: 20 }, () => f.engine.tick()));
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 2, 3, 4]);
  });
  it('evaluates expired pause without changing check-in', async () => {
    const f = await fixture();
    await auto(f.engine);
    await f.engine.pause(24);
    f.advance(0.5);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toHaveLength(0);
    f.advance(8);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 2]);
    expect(f.engine.status().silenceDays).toBe(8.5);
  });
  it('fails closed when the monitor lease dies during a started action', async () => {
    let held = true,
      finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const f = await fixture({
      lease: () => held,
      runner: {
        run: async () => {
          await gate;
          return [];
        },
      },
    });
    await auto(f.engine);
    f.advance(40);
    await f.engine.tick();
    await new Promise((r) => setTimeout(r, 0));
    held = false;
    finish();
    await f.engine.idle();
    expect(f.calls).toHaveLength(1);
    expect(f.engine.status().writable).toBe(false);
    held = true;
    expect(f.engine.status().writable).toBe(false);
    await expect(f.engine.tick()).rejects.toThrow('互斥锁');
  });
  it('never overwrites a new owner check-in when an old owner finishes or closes after lease loss', async () => {
    let stored: Document | null = null;
    let now = new Date('2026-11-02T12:00:00+08:00').getTime();
    let held = true,
      finish!: () => void,
      entered!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const repository: Repository = {
      load: async () => stored && structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    };
    const secrets: Secrets = {
      protect: async (targets) => JSON.stringify(targets),
      unprotect: async (token) => JSON.parse(token) as Targets,
    };
    const old = new CicadaEngine({
      repository,
      secrets,
      writable: true,
      lease: () => held,
      now: () => now,
      runner: {
        run: async () => {
          calls++;
          entered();
          await gate;
          return [];
        },
      },
    });
    await old.initialize();
    await live(old);
    await authorize(old);
    now += 40 * DAY;
    await old.tick();
    await started;
    held = false;
    const current = new CicadaEngine({
      repository,
      secrets,
      writable: true,
      lease: () => true,
      now: () => now,
      runner: { run: async () => [] },
    });
    await current.initialize();
    await current.checkin();
    const checkedIn = structuredClone(stored);
    const closing = old.close();
    finish();
    await closing;
    await old.idle();
    expect(stored).toEqual(checkedIn);
    expect(calls).toBe(1);
    expect(current.view().runs.filter((run) => run.state === 'interrupted')).toHaveLength(1);
    expect(old.status()).toMatchObject({ writable: false });
    held = true;
    expect(old.status().writable).toBe(false);
    await current.close();
  });
  it('fences a configuration save if its lease is lost while encrypting', async () => {
    let held = true,
      block = false,
      finish!: () => void,
      entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture({
      lease: () => held,
      secrets: {
        protect: async (targets) => {
          if (block) {
            entered();
            await gate;
          }
          return JSON.stringify(targets);
        },
        unprotect: async (token) => JSON.parse(token) as Targets,
      },
    });
    const original = structuredClone(f.stored());
    const view = f.engine.view();
    view.config.targets.keywords = ['synthetic'];
    block = true;
    const saving = f.engine.save({
      section: 'targets',
      config: view.config,
      expectedRevision: view.status.revision,
    });
    const rejected = expect(saving).rejects.toThrow('互斥锁');
    await started;
    held = false;
    finish();
    await rejected;
    expect(f.stored()).toEqual(original);
    expect(f.engine.view().config.targets.keywords).toEqual([]);
    await f.engine.close();
    expect(f.stored()).toEqual(original);
  });
  it('persists started before execution and blocks replay when completion cannot be saved', async () => {
    let fail!: () => void;
    const f = await fixture({
      runner: {
        run: async () => {
          fail();
          return [];
        },
      },
    });
    fail = f.failSave;
    await auto(f.engine);
    f.advance(4);
    await f.engine.tick();
    await expect(f.engine.idle()).rejects.toThrow();
    expect(f.stored().runs[0]!.state).toBe('started');
    const reopened = await fixture({ document: f.stored() });
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.engine.view().runs[0]!.state).toBe('interrupted');
    expect(reopened.calls).toHaveLength(0);
  });
  it('waits for started work before closing even if cancellation cannot be persisted', async () => {
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture({
      runner: {
        run: async () => {
          entered();
          await gate;
          return [];
        },
      },
    });
    await auto(f.engine);
    f.advance(40);
    await f.engine.tick();
    await started;
    f.failSave();
    let settled = false;
    const closing = f.engine.close();
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(closing).rejects.toThrow('disk failure');
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      finish();
    }
    await rejected;
    expect(f.stored().runs[0]!.state).toBe('started');
  });
  it('rechecks the clock before starting the next queued real level', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const f = await fixture({
      runner: {
        run: async () => {
          await gate;
          return [];
        },
      },
    });
    await live(f.engine);
    await authorize(f.engine);
    f.advance(40);
    await f.engine.tick();
    await new Promise((r) => setTimeout(r, 0));
    f.advance(-2);
    finish();
    await f.engine.idle();
    expect(f.calls).toHaveLength(1);
  });
  it('catches up every due level in order and never repeats completed lower levels', async () => {
    const f = await fixture();
    await auto(f.engine);
    f.advance(8);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 2]);
    f.advance(8);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 2, 3]);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toHaveLength(3);
  });
  it('keeps simulation and live eligibility separate', async () => {
    const f = await fixture();
    await auto(f.engine);
    f.advance(4);
    await f.engine.tick();
    await f.engine.idle();
    await live(f.engine);
    await authorize(f.engine);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls.map((c) => c.live)).toEqual([false, true]);
  });
  it('does not execute live automatically before explicit authorization', async () => {
    const f = await fixture();
    await live(f.engine);
    f.advance(40);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toHaveLength(0);
  });
  it('recovers a started run as interrupted and does not replay it', async () => {
    const f = await fixture();
    const d = f.stored();
    d.runs.push({
      id: 'uncertain',
      cycle: d.state.cycle,
      revision: d.revision,
      level: 1,
      mode: 'live',
      source: 'automatic',
      state: 'started',
      createdAt: 0,
      finishedAt: null,
      steps: [],
    });
    const reopened = await fixture({ document: d });
    expect(reopened.engine.status().blocked).toContain('中断');
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls).toHaveLength(0);
    expect(reopened.engine.view().runs[0]!.state).toBe('interrupted');
  });
  it('requires deliberate manual acknowledgement of interrupted runs', async () => {
    const d = freshDocument(Date.now(), 'x');
    d.runs.push({
      id: 'uncertain',
      cycle: 'x',
      revision: 0,
      level: 1,
      mode: 'live',
      source: 'automatic',
      state: 'started',
      createdAt: 0,
      finishedAt: null,
      steps: [],
    });
    const f = await fixture({ document: d });
    await expect(f.engine.resolveInterrupted('uncertain', 'yes')).rejects.toThrow();
    await f.engine.resolveInterrupted('uncertain', '已核查中断动作');
    expect(f.engine.view().runs[0]!.state).toBe('failed');
  });
  it('waits for a busy drill then executes automatic catch-up', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    let first = true;
    const f = await fixture({
      runner: {
        run: async () => {
          if (first) {
            first = false;
            await gate;
          }
          return [];
        },
      },
    });
    await auto(f.engine);
    await f.engine.drill();
    await new Promise((r) => setTimeout(r, 0));
    f.advance(8);
    await f.engine.tick();
    finish();
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 1, 2]);
  });
  it.each(['checkin', 'pause', 'safeMode', 'stopAutomation', 'close'] as const)(
    'cancels pending work on %s without interrupting started work',
    async (action) => {
      let finish!: () => void;
      const gate = new Promise<void>((r) => {
        finish = r;
      });
      const f = await fixture({
        runner: {
          run: async () => {
            await gate;
            return [];
          },
        },
      });
      await auto(f.engine);
      f.advance(40);
      await f.engine.tick();
      await new Promise((r) => setTimeout(r, 0));
      const cancellation = action === 'pause' ? f.engine.pause(4) : f.engine[action]();
      finish();
      await cancellation;
      await f.engine.idle();
      expect(f.calls).toHaveLength(1);
      expect(f.engine.view().runs.filter((r) => r.state === 'cancelled')).toHaveLength(3);
    },
  );
  it.each(['stopAutomation', 'safeMode'] as const)(
    '%s cancels live catch-up before the current level finishes',
    async (action) => {
      let finish!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const f = await fixture({
        runner: {
          run: async () => {
            entered();
            await gate;
            return [];
          },
        },
      });
      await live(f.engine);
      await authorize(f.engine);
      f.advance(40);
      const before = f.engine.view();
      await f.engine.tick();
      await started;
      try {
        const stopped = await f.engine[action]();
        expect(stopped.status).toMatchObject({
          busy: true,
          autoTrigger: false,
          authorized: false,
          lastCheckin: before.status.lastCheckin,
          dryRun: action === 'safeMode',
        });
        expect(stopped.runs.filter((run) => run.state === 'cancelled')).toHaveLength(3);
        expect(stopped.runs.filter((run) => run.state === 'started')).toHaveLength(1);
        expect(stopped.config.actions).toEqual(before.config.actions);
        const changed = structuredClone(stopped.config);
        changed.targets.folders = ['C:\\synthetic'];
        await expect(
          f.engine.save({ section: 'targets', config: changed, expectedRevision: stopped.status.revision }),
        ).rejects.toThrow('动作执行中');
      } finally {
        finish();
      }
      await f.engine.idle();
      await f.engine.tick();
      await f.engine.idle();
      expect(f.calls.map((call) => call.level)).toEqual([1]);
      expect(f.engine.view().runs.find((run) => run.state === 'completed')?.mode).toBe('live');
      if (action === 'safeMode') await live(f.engine);
      await authorize(f.engine);
      await f.engine.tick();
      await f.engine.idle();
      expect(f.calls.map((call) => call.level)).toEqual([1, 2, 3, 4]);
    },
  );
  it('stopping does not decrypt or encrypt targets and invalidates prepared confirmations', async () => {
    const f = await fixture();
    const pending = f.engine.prepare('execute', 'owner');
    await f.engine.stopAutomation();
    await expect(f.engine.confirm({ token: pending.token, phrase: '我确认' }, 'owner')).rejects.toThrow();
    const broken = structuredClone(f.stored());
    broken.settings.autoTrigger = true;
    broken.encryptedTargets = 'invalid';
    const failedSecrets: Secrets = {
      protect: async () => {
        throw new Error('DPAPI failed');
      },
      unprotect: async () => {
        throw new Error('DPAPI failed');
      },
    };
    const opened = await fixture({ document: broken, secrets: failedSecrets });
    await opened.engine.stopAutomation();
    expect(opened.engine.status()).toMatchObject({ autoTrigger: false, secretError: true });
    expect(opened.stored().encryptedTargets).toBe('invalid');
    const readonly = await fixture({ writable: false });
    await expect(readonly.engine.stopAutomation()).rejects.toThrow('只读');
  });
  for (const source of ['automatic', 'manual'] as const)
    it.each(['stopAutomation', 'safeMode'] as const)(
      `%s fences ${source} live work when its stop write fails until an explicit retry succeeds`,
      async (action) => {
        let finish!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const f = await fixture({
          runner: {
            run: async () => {
              entered();
              await gate;
              return [];
            },
          },
        });
        await live(f.engine);
        await authorize(f.engine);
        f.advance(40);
        if (source === 'automatic') await f.engine.tick();
        else {
          const confirmation = f.engine.prepare('execute', 'owner');
          await f.engine.confirm({ token: confirmation.token, phrase: '我确认' }, 'owner');
        }
        await started;
        try {
          const before = structuredClone(f.stored());
          f.failSave();
          await expect(f.engine[action]()).rejects.toThrow('停止设置保存失败');
          expect(f.stored()).toEqual(before);
          expect(f.engine.status()).toMatchObject({ authorized: false, busy: true });
          expect(f.engine.status().blocked).toContain('停止设置尚未保存');
          expect(() => f.engine.prepare('execute', 'owner')).toThrow('停止设置');
          f.restoreSave();
        } finally {
          f.restoreSave();
          finish();
        }
        await f.engine.idle();
        await f.engine.tick();
        await f.engine.idle();
        expect(f.calls.map((call) => [call.level, call.live])).toEqual([[1, true]]);
        expect(f.engine.view().runs.filter((run) => run.state === 'cancelled')).toHaveLength(3);
        expect(f.engine.status().blocked).toContain('停止设置尚未保存');
        await expect(f.engine.drill()).rejects.toThrow('停止设置');
        await f.engine[action]();
        expect(f.engine.status()).toMatchObject({ autoTrigger: false, authorized: false, blocked: '' });
        const reopened = await fixture({ document: f.stored() });
        await reopened.engine.tick();
        await reopened.engine.idle();
        expect(reopened.calls).toEqual([]);
        if (action === 'safeMode') await live(f.engine);
        await authorize(f.engine);
        await f.engine.tick();
        await f.engine.idle();
        expect(f.calls.map((call) => call.level)).toEqual([1, 2, 3, 4]);
      },
    );
  it('records failure without automatically retrying the destructive level', async () => {
    const f = await fixture({
      runner: {
        run: async () => {
          throw new Error('secret path');
        },
      },
    });
    await auto(f.engine);
    f.advance(4);
    await f.engine.tick();
    await f.engine.idle();
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.stored())).not.toContain('secret path');
  });
});

describe('legacy execution review', () => {
  async function imported(levels: number[] = [1, 2]) {
    const f = await fixture();
    const confirmation = f.engine.prepare('import', 'owner', {
      config: defaults(),
      lastCheckin: f.engine.now() - 8 * DAY,
      pausedUntil: null,
      executedLevels: levels,
      warnings: [],
    });
    await f.engine.confirm({ token: confirmation.token, phrase: '我确认' }, 'owner');
    await f.engine.idle();
    return f;
  }
  it('does not treat unknown imported levels as real completion or silently replay them', async () => {
    const f = await imported();
    expect(f.engine.view().legacyLevels).toEqual([1, 2]);
    for (const kind of ['live', 'authorize', 'execute'] as const)
      expect(() => f.engine.prepare(kind, 'owner')).toThrow('核查旧版');
    await auto(f.engine);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toEqual([]);
    await f.engine.drill();
    await f.engine.idle();
    expect(f.calls.every((call) => !call.live)).toBe(true);
    expect(f.engine.view().legacyLevels).toEqual([1, 2]);
  });
  it('restores real eligibility after review of drill-only records, including after restart', async () => {
    const f = await imported();
    for (const level of [1, 2])
      await f.engine.resolveLegacy(level, 'drill', '已核查仅为演练', f.engine.status().revision);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.calls).toEqual([]);
    expect(f.engine.view().legacyLevels).toEqual([]);
    expect(f.engine.view().runs.every((run) => run.source === 'legacy' && run.mode === 'drill')).toBe(true);
    const reopened = await fixture({ document: f.stored() });
    await live(reopened.engine);
    await authorize(reopened.engine);
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls.map((call) => [call.level, call.live])).toEqual([
      [1, true],
      [2, true],
    ]);
  });
  it('never automatically replays a level reviewed as real', async () => {
    const f = await imported();
    await f.engine.resolveLegacy(1, 'live', '已核查真实执行', f.engine.status().revision);
    expect(() => f.engine.prepare('execute', 'owner')).toThrow('核查旧版');
    await f.engine.resolveLegacy(2, 'drill', '已核查仅为演练', f.engine.status().revision);
    const reopened = await fixture({ document: f.stored() });
    await live(reopened.engine);
    await authorize(reopened.engine);
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls.map((call) => call.level)).toEqual([2]);
  });
  it('retains unknown records across check-in, safe mode and another import', async () => {
    const f = await imported([1]);
    await f.engine.checkin();
    await f.engine.safeMode();
    const confirmation = f.engine.prepare('import', 'owner', {
      config: defaults(),
      lastCheckin: null,
      pausedUntil: null,
      executedLevels: [2],
      warnings: [],
    });
    await f.engine.confirm({ token: confirmation.token, phrase: '我确认' }, 'owner');
    await f.engine.idle();
    expect(f.engine.view().legacyLevels).toEqual([1, 2]);
    expect(() => f.engine.prepare('live', 'owner')).toThrow('核查旧版');
  });
  it('upgrades old live-authorized documents with legacy levels into a blocked review state', async () => {
    const f = await fixture();
    await live(f.engine);
    await authorize(f.engine);
    const old = structuredClone(f.stored());
    old.state.legacyLevels = [1, 2];
    old.state.lastCheckin -= 40 * DAY;
    const reopened = await fixture({ document: old });
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls).toEqual([]);
    await reopened.engine.resolveLegacy(1, 'drill', '已核查仅为演练', reopened.engine.status().revision);
    await reopened.engine.resolveLegacy(2, 'live', '已核查真实执行', reopened.engine.status().revision);
    expect(reopened.engine.status()).toMatchObject({ autoTrigger: false, authorized: false });
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.calls).toEqual([]);
  });
  it('rejects invalid, stale and failed review writes without losing the pending record', async () => {
    const f = await imported([1]);
    const revision = f.engine.status().revision;
    await expect(f.engine.resolveLegacy(0, 'drill', '已核查仅为演练', revision)).rejects.toThrow();
    await expect(f.engine.resolveLegacy(1, 'drill', '已核查真实执行', revision)).rejects.toThrow();
    await f.engine.pause(1);
    await expect(f.engine.resolveLegacy(1, 'drill', '已核查仅为演练', revision)).rejects.toThrow(
      '状态已变化',
    );
    f.failSave();
    await expect(
      f.engine.resolveLegacy(1, 'drill', '已核查仅为演练', f.engine.status().revision),
    ).rejects.toThrow('disk failure');
    expect(f.engine.view().legacyLevels).toEqual([1]);
    expect(f.engine.view().runs).toEqual([]);
  });
});

describe('configuration and owner confirmation', () => {
  it('clears a pending reminder on disable and does not repeat it when re-enabled on the same day', async () => {
    const f = await fixture();
    f.setTime(new Date(2026, 10, 1, 12).getTime());
    await f.engine.checkin();
    const evening = new Date(2026, 10, 2, 21, 30).getTime();
    f.setTime(evening);
    await f.engine.tick();
    await f.engine.idle();
    expect(f.engine.status().reminderPending).toBe(true);
    const view = f.engine.view();
    view.config.reminderEnabled = false;
    await f.engine.save({ section: 'rules', config: view.config, expectedRevision: view.status.revision });
    await f.engine.tick();
    expect(f.engine.status().reminderPending).toBe(false);
    expect(f.stored().state.reminderPending).toBe(false);
    const reopened = await fixture({ document: f.stored() });
    reopened.setTime(evening);
    await reopened.engine.tick();
    await reopened.engine.idle();
    expect(reopened.engine.status().reminderPending).toBe(false);
    const enabled = reopened.engine.view();
    enabled.config.reminderEnabled = true;
    await reopened.engine.save({
      section: 'rules',
      config: enabled.config,
      expectedRevision: enabled.status.revision,
    });
    await reopened.engine.tick();
    expect(reopened.engine.status().reminderPending).toBe(false);
    reopened.advance(1);
    await reopened.engine.tick();
    expect(reopened.engine.status().reminderPending).toBe(true);
  });
  it('suppresses and repairs disabled reminders left pending by older versions', async () => {
    const baseline = await fixture();
    const document = structuredClone(baseline.stored());
    document.settings.reminderEnabled = false;
    document.state.reminderPending = true;
    const readonly = await fixture({ document, writable: false });
    expect(readonly.engine.status().reminderPending).toBe(false);
    const opened = await fixture({ document });
    expect(opened.stored().state.reminderPending).toBe(false);
    const view = opened.engine.view();
    view.config.reminderEnabled = true;
    await opened.engine.save({
      section: 'rules',
      config: view.config,
      expectedRevision: view.status.revision,
    });
    expect(opened.engine.status().reminderPending).toBe(false);
    opened.setTime(new Date(2026, 10, 3, 21, 30).getTime());
    await opened.engine.tick();
    expect(opened.engine.status().reminderPending).toBe(true);
  });
  it.each([
    [0, 1, 2, 3],
    [3, 3, 7, 9],
    [3, 2, 7, 9],
    [NaN, 7, 14, 30],
    [Infinity, 7, 14, 30],
  ])('rejects invalid thresholds %s', async (levels) => {
    const f = await fixture();
    const v = f.engine.view();
    v.config.levels = levels;
    await expect(
      f.engine.save({ section: 'rules', config: v.config, expectedRevision: 0 }),
    ).rejects.toThrow();
    expect(f.engine.view().config.levels).toEqual([3, 7, 14, 30]);
  });
  it('supports increasing fractional days', async () => {
    const f = await fixture();
    const v = f.engine.view();
    v.config.levels = [0.01, 0.1, 1.5, 2.1];
    await f.engine.save({ section: 'rules', config: v.config, expectedRevision: 0 });
    expect(f.engine.view().config.levels[0]).toBe(0.01);
  });
  it('saving one section never overwrites another section', async () => {
    const f = await fixture();
    const v = f.engine.view();
    v.config.persona = 'gamer';
    v.config.levels = [1, 2, 3, 4];
    await f.engine.save({ section: 'history', config: v.config, expectedRevision: 0 });
    expect(f.engine.view().config.persona).toBe('gamer');
    expect(f.engine.view().config.levels).toEqual([3, 7, 14, 30]);
  });
  it('rejects stale revisions and preserves persisted values', async () => {
    const f = await fixture();
    const v = f.engine.view();
    await f.engine.checkin();
    await expect(f.engine.save({ section: 'rules', config: v.config, expectedRevision: 0 })).rejects.toThrow(
      '配置已变化',
    );
  });
  it('confirmation is peer-bound, revision-bound and single-use', async () => {
    const f = await fixture();
    let c = f.engine.prepare('live', 'a');
    await expect(f.engine.confirm({ token: c.token, phrase: '我确认' }, 'b')).rejects.toThrow();
    await expect(f.engine.confirm({ token: c.token, phrase: '我确认' }, 'a')).rejects.toThrow();
    c = f.engine.prepare('live', 'a');
    await f.engine.checkin();
    await expect(f.engine.confirm({ token: c.token, phrase: '我确认' }, 'a')).rejects.toThrow();
  });
  it('expired confirmations do not switch mode', async () => {
    const f = await fixture();
    const c = f.engine.prepare('live', 'a');
    f.advance(0.01);
    await expect(f.engine.confirm({ token: c.token, phrase: '我确认' }, 'a')).rejects.toThrow();
    expect(f.engine.status().dryRun).toBe(true);
  });
  it('changing dangerous configuration revokes existing authorization', async () => {
    const f = await fixture();
    await live(f.engine);
    await authorize(f.engine);
    const v = f.engine.view();
    v.config.actions.shredFolders = false;
    await f.engine.save({ section: 'rules', config: v.config, expectedRevision: v.status.revision });
    expect(f.engine.status()).toMatchObject({ authorized: false, autoTrigger: false });
  });
  it('sensitive encryption failure never overwrites old ciphertext', async () => {
    const d = freshDocument(Date.now(), 'x');
    d.encryptedTargets = 'old-token';
    const f = await fixture({
      document: d,
      secrets: {
        protect: async () => {
          throw new Error();
        },
        unprotect: async () => {
          throw new Error();
        },
      },
    });
    expect(f.engine.status().secretError).toBe(true);
    expect(() => f.engine.prepare('execute', 'a')).toThrow();
    const v = f.engine.view();
    await expect(
      f.engine.save({ section: 'history', config: v.config, expectedRevision: 0 }),
    ).rejects.toThrow();
    expect(f.stored().encryptedTargets).toBe('old-token');
  });
  it.each(['', '   '])(
    'blocks missing ciphertext %j without requiring an existing authorization',
    async (token) => {
      const baseline = await fixture();
      const document = structuredClone(baseline.stored());
      document.settings.dryRun = false;
      document.settings.autoTrigger = true;
      document.state.lastCheckin -= 40 * DAY;
      document.encryptedTargets = token;
      document.authorization = null;
      const f = await fixture({ document });
      expect(f.engine.status()).toMatchObject({ secretError: true, authorized: false });
      for (const kind of ['live', 'authorize', 'execute'] as const)
        expect(() => f.engine.prepare(kind, 'owner')).toThrow('敏感配置');
      await f.engine.tick();
      await f.engine.idle();
      expect(f.calls).toHaveLength(0);
      await f.engine.checkin();
      await f.engine.safeMode();
      expect(f.engine.status().secretError).toBe(true);
      const view = f.engine.view();
      await expect(
        f.engine.save({ section: 'history', config: view.config, expectedRevision: view.status.revision }),
      ).rejects.toThrow('恢复敏感配置');
      expect(f.stored().encryptedTargets).toBe(token);
      view.config.targets.keywords = ['restored-synthetic'];
      await f.engine.save({
        section: 'targets',
        config: view.config,
        expectedRevision: view.status.revision,
      });
      expect(f.engine.status()).toMatchObject({ secretError: false, authorized: false, autoTrigger: false });
      expect(f.engine.view().config.targets.keywords).toEqual(['restored-synthetic']);
      const reopened = await fixture({ document: f.stored() });
      expect(reopened.engine.status().secretError).toBe(false);
    },
  );
  it('rejects empty encryption results without replacing valid ciphertext', async () => {
    let broken = false;
    const f = await fixture({
      secrets: {
        protect: async (targets) => (broken ? '' : JSON.stringify(targets)),
        unprotect: async (token) => JSON.parse(token) as Targets,
      },
    });
    const original = structuredClone(f.stored());
    const view = f.engine.view();
    broken = true;
    await expect(
      f.engine.save({ section: 'targets', config: view.config, expectedRevision: view.status.revision }),
    ).rejects.toThrow('空密文');
    expect(f.stored()).toEqual(original);
  });
  it('manual full execution remains separately confirmed in drill mode', async () => {
    const f = await fixture();
    const c = f.engine.prepare('execute', 'a');
    await f.engine.confirm({ token: c.token, phrase: '我确认' }, 'a');
    await f.engine.idle();
    expect(f.calls.map((c) => c.level)).toEqual([1, 2, 3, 4]);
    expect(f.calls.every((c) => c.live)).toBe(true);
    expect(f.engine.status().dryRun).toBe(true);
  });
  it('imports a copy with live mode and automatic triggers disabled', async () => {
    const f = await fixture();
    const config = defaults();
    config.dryRun = false;
    config.autoTrigger = true;
    const c = f.engine.prepare('import', 'a', {
      config,
      lastCheckin: f.engine.now() - 10 * DAY,
      pausedUntil: null,
      executedLevels: [1],
      warnings: [],
    });
    await f.engine.confirm({ token: c.token, phrase: '我确认' }, 'a');
    await f.engine.idle();
    expect(f.engine.status()).toMatchObject({
      dryRun: true,
      autoTrigger: false,
      authorized: false,
      silenceDays: 10,
    });
    expect(f.stored().state.legacyLevels).toEqual([1]);
  });
});
