import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const PROFILE = 'cicada-fixture';

export function assertNoExternalTarget(environment) {
  if (environment.CICADA_TEST_URL !== undefined)
    throw new Error('CICADA_TEST_URL is no longer accepted; the test must create and own its Host');
}

export function fixtureEnvironment(inherited, directory) {
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]);
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([name]) => allowed.has(name.toUpperCase()))),
    DSH_HOME: join(directory, 'home'),
    DSH_AGENTS_HOME: join(directory, 'agents'),
    DSH_TELEMETRY_MODE: 'DISABLED',
    ELECTRON_RUN_AS_NODE: '1',
  };
}

function assertAlive(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    throw new Error('Owned test Host is no longer running');
}

export function announcedUrl(line) {
  const match = /^dsh web: (https?:\/\/\S+)$/.exec(line.trim());
  return match?.[1] ?? null;
}

export async function assertOwnedListener(url, child, inspect) {
  assertAlive(child);
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('The owned Host must announce a loopback HTTP root on its assigned port');
  const rows = await inspect(port);
  assertAlive(child);
  if (!Array.isArray(rows)) throw new Error('Invalid Windows listener inspection result');
  const listeners = rows.filter((row) => row.address === '127.0.0.1');
  if (listeners.length !== 1 || listeners[0].pid !== child.pid)
    throw new Error('Test URL listener is not owned by the Host process created by this test');
}

export async function withOwnedHarness(runtime, visit) {
  assertNoExternalTarget(runtime.environment);
  const fixture = await runtime.create();
  let host,
    result,
    failure,
    installationAttempted = false;
  const cleanup = [];
  try {
    const version = (await runtime.cli(fixture, ['--version'])).trim();
    await runtime.validateVersion(version);
    await runtime.cli(fixture, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config']);
    installationAttempted = true;
    await runtime.cli(fixture, ['plugin', '--profile', PROFILE, 'add', fixture.package, '--ignore-scripts']);
    await runtime.cli(fixture, ['--profile', PROFILE, '--dump-config']);
    host = runtime.start(fixture, ['--profile', PROFILE, '--host', '127.0.0.1', '--port', '0', '--no-open']);
    const url = await host.ready;
    const assertOwned = () => assertOwnedListener(url, host.child, runtime.inspect);
    await assertOwned();
    result = await visit({
      url,
      directory: fixture.directory,
      signal: host.signal,
      assertOwned,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (host) {
      try {
        await host.stop();
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (installationAttempted) {
      if (host && host.child.exitCode === null && host.child.signalCode === null)
        cleanup.push(new Error('Host shutdown is unconfirmed; refusing to remove its running plugin'));
      else {
        try {
          await runtime.cli(fixture, ['plugin', '--profile', PROFILE, 'remove', 'dsh-cicada']);
        } catch (error) {
          cleanup.push(error);
        }
      }
    }
  }
  if (cleanup.length)
    throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Isolated Host cleanup failed');
  if (failure) throw failure;
  return { directory: fixture.directory, result };
}

async function desktopCli(explicitExecutable) {
  if (process.platform !== 'win32') throw new Error('Live Harness smoke tests require local Windows');
  let executable = explicitExecutable && resolve(explicitExecutable);
  if (!executable) {
    const { stdout } = await exec('where.exe', ['dsh'], { windowsHide: true, timeout: 10000 });
    const launcher = stdout
      .split(/\r?\n/)
      .find((path) => /[\\/]runtime[\\/]cli[\\/]bin[\\/]dsh\.cmd$/i.test(path));
    if (!launcher)
      throw new Error('Desktop CLI not found; pass --desktop-exe <installed Harness executable>');
    executable = resolve(dirname(launcher), '../../../..', 'DeepSeek Harness.exe');
  }
  if (basename(executable).toLowerCase() !== 'deepseek harness.exe')
    throw new Error('Expected the official installed DeepSeek Harness executable');
  await access(executable);
  await access(join(dirname(executable), 'resources', 'app.asar'));
  return {
    executable,
    entry: join(
      dirname(executable),
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    ),
  };
}

async function freshDirectory() {
  const workspace = await realpath(root);
  const artifacts = join(workspace, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  if (
    (await lstat(artifacts)).isSymbolicLink() ||
    relative(workspace, await realpath(artifacts)) !== 'artifacts'
  )
    throw new Error('Test artifacts directory must not redirect outside the workspace');
  const directory = await mkdtemp(join(artifacts, 'harness-owned-'));
  for (const name of ['home', 'agents', 'workspace']) await mkdir(join(directory, name));
  return directory;
}

function ownedHost(cli, fixture, args) {
  const nonce = randomUUID();
  const log = createWriteStream(join(fixture.directory, 'host.log'), { flags: 'wx' });
  log.on('error', () => {});
  const child = spawn(
    cli.executable,
    [
      '--expose-internals',
      '--import',
      pathToFileURL(fileURLToPath(new URL('./harness-shutdown.mjs', import.meta.url))).href,
      cli.entry,
      ...args,
    ],
    {
      cwd: join(fixture.directory, 'workspace'),
      env: { ...fixture.env, CICADA_FIXTURE_NONCE: nonce },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const abort = new AbortController();
  const stopped = new Promise((done) => {
    const complete = (code, signal) => {
      abort.abort();
      done({ code, signal });
    };
    child.once('exit', complete);
    child.once('close', complete);
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const outputEnded = Promise.all([
    finished(child.stdout, { cleanup: true }),
    finished(child.stderr, { cleanup: true }),
  ]);
  outputEnded.catch(() => {});
  let timer;
  const ready = new Promise((done, fail) => {
    let buffer = '',
      settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(
      () => settle(fail, new Error('Owned Host startup timed out; inspect its isolated host.log')),
      60000,
    );
    child.once('error', (error) => settle(fail, error));
    child.once('exit', () =>
      settle(fail, new Error('Owned Host exited before announcing its URL; inspect its isolated host.log')),
    );
    child.once('close', () =>
      settle(fail, new Error('Owned Host exited before announcing its URL; inspect its isolated host.log')),
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      if (buffer.length > 65536) buffer = '';
      for (const line of lines) {
        const url = announcedUrl(line);
        if (url) settle(done, url);
      }
    });
  });
  return {
    child,
    ready,
    signal: abort.signal,
    async stop() {
      clearTimeout(timer);
      let forced = false;
      const killTimer = setTimeout(() => {
        forced = true;
        child.kill();
      }, 15000);
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          if (child.connected) {
            try {
              await new Promise((done, fail) =>
                child.send({ kind: 'cicada-fixture-stop', nonce }, (error) => (error ? fail(error) : done())),
              );
            } catch {
              forced = true;
              child.kill();
            }
          } else {
            forced = true;
            child.kill();
          }
        }
        const result = await stopped;
        clearTimeout(killTimer);
        await outputEnded;
        if (forced || result.code !== 0)
          throw new Error('Owned Host did not exit cleanly; its isolated artifacts are retained');
      } finally {
        clearTimeout(killTimer);
        log.end();
        await finished(log);
      }
    },
  };
}

export async function localHarnessRuntime(plugin, validateVersion, executable) {
  assertNoExternalTarget(process.env);
  const cli = await desktopCli(executable);
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return {
    environment: process.env,
    validateVersion,
    async create() {
      const directory = await freshDirectory();
      const packagePath = join(root, 'dist', `${plugin.name}-${plugin.version}.tgz`);
      if ((await lstat(packagePath)).isSymbolicLink()) throw new Error('Test package must not be a link');
      return { directory, package: packagePath, env: fixtureEnvironment(process.env, directory) };
    },
    async cli(fixture, args) {
      const { stdout } = await exec(cli.executable, ['--expose-internals', cli.entry, ...args], {
        cwd: join(fixture.directory, 'workspace'),
        env: fixture.env,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    },
    start: (fixture, args) => ownedHost(cli, fixture, args),
    async inspect(port) {
      const { stdout } = await exec(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fileURLToPath(new URL('./harness-listener.ps1', import.meta.url)),
          '-Port',
          String(port),
        ],
        { windowsHide: true, timeout: 10000 },
      );
      const rows = JSON.parse(stdout);
      if (!Array.isArray(rows)) throw new Error('Invalid Windows listener inspection result');
      return rows;
    },
  };
}
