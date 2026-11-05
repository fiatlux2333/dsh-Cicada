import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  announcedUrl,
  assertOwnedListener,
  fixtureEnvironment,
  withOwnedHarness,
} from '../scripts/harness-fixture.mjs';

const url = 'http://127.0.0.1:51347/?token=fixture-only';
function runtimeFixture() {
  const child = { pid: 417, exitCode: null as number | null, signalCode: null as string | null };
  const abort = new AbortController();
  const directory = 'C:\\workspace\\artifacts\\harness-owned-fixture';
  const calls: string[] = [];
  const host = {
    child,
    ready: Promise.resolve(url),
    signal: abort.signal,
    stop: vi.fn(async () => {
      calls.push('stop');
      child.exitCode = 0;
      abort.abort();
    }),
  };
  const runtime = {
    environment: {} as Record<string, string>,
    create: vi.fn(async () => ({
      directory,
      package: 'C:\\workspace\\dist\\fixture.tgz',
      env: fixtureEnvironment({}, directory),
    })),
    validateVersion: vi.fn(),
    cli: vi.fn(async (_fixture: unknown, args: string[]) => {
      calls.push(args.join(' '));
      return args[0] === '--version' ? '0.2.2-rc.1' : 'fixture-composed-config';
    }),
    start: vi.fn(() => host),
    inspect: vi.fn(async () => [{ address: '127.0.0.1', pid: child.pid }]),
  };
  return { runtime, host, child, calls, directory };
}

describe('owned Harness smoke isolation using process and Windows substitutes', () => {
  it('rejects the old external URL entry before creating directories or invoking any CLI', async () => {
    const { runtime } = runtimeFixture();
    runtime.environment = {
      CICADA_TEST_URL: 'http://127.0.0.1:4189/?token=daily',
      DSH_HOME: 'C:\\workspace\\artifacts\\looks-isolated',
    };
    const visit = vi.fn();
    await expect(withOwnedHarness(runtime, visit)).rejects.toThrow('no longer accepted');
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.cli).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(visit).not.toHaveBeenCalled();
  });
  it('overrides inherited homes and excludes provider credentials and Node preload settings', () => {
    const env = fixtureEnvironment(
      {
        PATH: 'fixture-path',
        SystemRoot: 'C:\\Windows',
        DSH_HOME: 'C:\\daily',
        DSH_AGENTS_HOME: 'C:\\daily-agents',
        DSH_TELEMETRY_MODE: 'ENABLED',
        DSH_WEB_URL: url,
        DEEPSEEK_API_KEY: 'not-for-test',
        OPENAI_API_KEY: 'not-for-test',
        NODE_OPTIONS: '--import daily.mjs',
        NODE_PATH: 'C:\\daily-node',
      },
      'C:\\workspace\\artifacts\\fresh',
    );
    expect(env.DSH_HOME).toBe('C:\\workspace\\artifacts\\fresh\\home');
    expect(env.DSH_AGENTS_HOME).toBe('C:\\workspace\\artifacts\\fresh\\agents');
    expect(env.DSH_TELEMETRY_MODE).toBe('DISABLED');
    expect(env.PATH).toBe('fixture-path');
    expect(env.SystemRoot).toBe('C:\\Windows');
    for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'DSH_WEB_URL'])
      expect(env).not.toHaveProperty(key);
  });
  it('accepts readiness only from the official Host announcement line', () => {
    expect(announcedUrl(`dsh web: ${url}`)).toBe(url);
    expect(announcedUrl(`dsh web: opening the default browser; ${url}`)).toBeNull();
    expect(announcedUrl(`unrelated output ${url}`)).toBeNull();
  });
  it.each([
    'http://localhost:51347/',
    'http://192.168.1.2:51347/',
    'https://127.0.0.1:51347/',
    'http://127.0.0.1/',
    'http://127.0.0.1:51347/other',
    'http://name:password@127.0.0.1:51347/',
  ])('refuses non-owned-root URL %s without reading or changing a Host', async (target) => {
    const { child, runtime } = runtimeFixture();
    await expect(assertOwnedListener(target, child, runtime.inspect)).rejects.toThrow('loopback HTTP root');
    expect(runtime.inspect).not.toHaveBeenCalled();
  });
  it('refuses a daily listener even if the URL was printed by the new test process', async () => {
    const { runtime, host } = runtimeFixture();
    runtime.inspect.mockResolvedValue([{ address: '127.0.0.1', pid: 999 }]);
    const visit = vi.fn();
    await expect(withOwnedHarness(runtime, visit)).rejects.toThrow('not owned');
    expect(visit).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(runtime.cli).toHaveBeenLastCalledWith(expect.anything(), [
      'plugin',
      '--profile',
      'cicada-fixture',
      'remove',
      'dsh-cicada',
    ]);
  });
  it.each([
    { rows: [] },
    { rows: [{ address: '0.0.0.0', pid: 417 }] },
    {
      rows: [
        { address: '127.0.0.1', pid: 417 },
        { address: '127.0.0.1', pid: 999 },
      ],
    },
  ])('refuses missing, wildcard or ambiguous listeners', async ({ rows }) => {
    const { child } = runtimeFixture();
    await expect(assertOwnedListener(url, child, async () => rows)).rejects.toThrow('not owned');
  });
  it('does not trust a Host that exits during Windows listener inspection', async () => {
    const { child } = runtimeFixture();
    await expect(
      assertOwnedListener(url, child, async () => {
        child.exitCode = 1;
        return [{ address: '127.0.0.1', pid: child.pid }];
      }),
    ).rejects.toThrow('no longer running');
  });
  it('owns initialization, port zero startup, verification and plugin removal in order', async () => {
    const { runtime, calls, directory } = runtimeFixture();
    const visit = vi.fn(async (fixture) => {
      expect(fixture.url).toBe(url);
      await fixture.assertOwned();
      calls.push('visit');
      return 'passed';
    });
    expect(await withOwnedHarness(runtime, visit)).toEqual({ directory, result: 'passed' });
    expect(runtime.validateVersion).toHaveBeenCalledWith('0.2.2-rc.1');
    expect(runtime.start).toHaveBeenCalledWith(expect.anything(), [
      '--profile',
      'cicada-fixture',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ]);
    expect(runtime.inspect).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      '--version',
      '--profile cicada-fixture --from-default-profile web --dump-config',
      'plugin --profile cicada-fixture add C:\\workspace\\dist\\fixture.tgz --ignore-scripts',
      '--profile cicada-fixture --dump-config',
      'visit',
      'stop',
      'plugin --profile cicada-fixture remove dsh-cicada',
    ]);
  });
  it('waits for confirmed Host exit before removing its plugin', async () => {
    const { runtime, child, host } = runtimeFixture();
    let release!: () => void;
    const stopping = new Promise<void>((done) => {
      release = done;
    });
    host.stop.mockImplementation(async () => {
      await stopping;
      child.exitCode = 0;
    });
    const work = withOwnedHarness(runtime, vi.fn());
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalled());
    expect(runtime.cli.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false);
    release();
    await work;
    expect(runtime.cli.mock.calls.at(-1)![1]).toContain('remove');
  });
  it('cleans up its own installation when UI assertions fail and retains the original error', async () => {
    const { runtime, host } = runtimeFixture();
    const error = new Error('fixture UI assertion failed');
    await expect(withOwnedHarness(runtime, vi.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(host.stop).toHaveBeenCalled();
    expect(runtime.cli.mock.calls.at(-1)![1]).toContain('remove');
  });
  it('cleans up a partial plugin installation without ever starting a Host', async () => {
    const { runtime } = runtimeFixture();
    runtime.cli.mockImplementation(async (_fixture, args) => {
      if (args.includes('add')) throw new Error('fixture installation failed');
      return '0.2.2-rc.1';
    });
    await expect(withOwnedHarness(runtime, vi.fn())).rejects.toThrow('installation failed');
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.cli.mock.calls.at(-1)![1]).toContain('remove');
  });
  it('rejects an untested Host version before installing or starting anything', async () => {
    const { runtime } = runtimeFixture();
    runtime.validateVersion.mockImplementation(() => {
      throw new Error('fixture unsupported version');
    });
    await expect(withOwnedHarness(runtime, vi.fn())).rejects.toThrow('unsupported version');
    expect(runtime.cli).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
  });
  it('never removes a plugin while its Host may still be running', async () => {
    const { runtime, host } = runtimeFixture();
    host.stop.mockRejectedValue(new Error('fixture shutdown unconfirmed'));
    const work = withOwnedHarness(runtime, vi.fn());
    await expect(work).rejects.toThrow('cleanup failed');
    expect(runtime.cli.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  });
  it('cleans up after early Host failure before allowing UI interaction', async () => {
    const { runtime, host, child } = runtimeFixture();
    runtime.start.mockImplementation(() => {
      child.exitCode = 1;
      return { ...host, ready: Promise.reject(new Error('fixture Host boot failed')) };
    });
    const visit = vi.fn();
    await expect(withOwnedHarness(runtime, visit)).rejects.toThrow('boot failed');
    expect(visit).not.toHaveBeenCalled();
    expect(runtime.cli.mock.calls.at(-1)![1]).toContain('remove');
  });
  it('reports cleanup errors alongside the failed UI assertion instead of claiming success', async () => {
    const { runtime } = runtimeFixture();
    runtime.cli.mockImplementation(async (_fixture, args) => {
      if (args.includes('remove')) throw new Error('fixture uninstall failed');
      return '0.2.2-rc.1';
    });
    let failure: unknown;
    try {
      await withOwnedHarness(runtime, vi.fn().mockRejectedValue(new Error('fixture UI failed')));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => error.message)).toEqual([
      'fixture UI failed',
      'fixture uninstall failed',
    ]);
  });
});

describe('shutdown IPC with harmless owned Node subprocesses only', () => {
  async function childFixture() {
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../scripts/harness-shutdown.mjs', import.meta.url).href,
        '--eval',
        "process.on('SIGTERM', () => process.exit(0)); process.on('message', (m) => { if (m.kind === 'probe') process.send({ kind: 'probe' }); }); process.send({ kind: 'ready' }); setInterval(() => {}, 1000);",
      ],
      {
        env: {
          ...fixtureEnvironment(process.env, 'C:\\fixture-unused'),
          CICADA_FIXTURE_NONCE: 'fixture-nonce',
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const exited = new Promise<number | null>((done) => {
      child.once('exit', done);
      child.once('close', done);
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const cleanup = async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    };
    try {
      expect((await once(child, 'message'))[0]).toEqual({ kind: 'ready' });
      return { child, exited, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  it('ignores the wrong nonce and delivers the accepted stop through normal disposal', async () => {
    const { child, exited, cleanup } = await childFixture();
    try {
      child.send({ kind: 'cicada-fixture-stop', nonce: 'wrong-nonce' });
      const response = once(child, 'message');
      child.send({ kind: 'probe' });
      expect((await response)[0]).toEqual({ kind: 'probe' });
      child.send({ kind: 'cicada-fixture-stop', nonce: 'fixture-nonce' });
      expect(await exited).toBe(0);
    } finally {
      await cleanup();
    }
  });
  it('disposes the owned subprocess if its parent IPC channel disappears', async () => {
    const { child, exited, cleanup } = await childFixture();
    try {
      child.disconnect();
      expect(await exited).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
