import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { targetsSchema } from '../shared/config.ts';
import type { Secrets } from './engine.ts';
import type { Targets } from '../shared/types.ts';

const sourceBridge = fileURLToPath(new URL('../../windows/bridge.ps1', import.meta.url));
const bridge = existsSync(sourceBridge)
  ? sourceBridge
  : fileURLToPath(new URL('../windows/bridge.ps1', import.meta.url));
function start(operation: string): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') throw new Error('Windows required');
  const powershell = resolve(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  return spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      bridge,
      '-Operation',
      operation,
      ...(operation === 'mutex' ? ['-OwnerPid', String(process.pid)] : []),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
export async function windowsCall<T>(
  operation: 'protect' | 'unprotect' | 'close-browser' | 'apps' | 'uninstall' | 'traces' | 'events',
  input: object,
  timeout = 30000,
): Promise<T> {
  return new Promise((done, fail) => {
    const child = start(operation);
    let output = '',
      error = false;
    const timer = setTimeout(() => {
      error = true;
      child.kill();
      fail(new Error('Windows operation timed out'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) {
        error = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      fail(new Error('Windows helper unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (error || code !== 0) return fail(new Error('Windows operation failed'));
      try {
        const data = JSON.parse(output.trim());
        if (data.error) throw new Error();
        done(data as T);
      } catch {
        fail(new Error('Invalid Windows helper response'));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
export const windowsSecrets: Secrets = {
  async protect(targets: Targets): Promise<string> {
    return (
      await windowsCall<{ text: string }>('protect', { text: JSON.stringify(targetsSchema.parse(targets)) })
    ).text;
  },
  async unprotect(token: string): Promise<Targets> {
    return targetsSchema.parse(
      JSON.parse((await windowsCall<{ text: string }>('unprotect', { text: token })).text),
    );
  },
};
export async function acquireMonitor(): Promise<{
  acquired: boolean;
  alive: () => boolean;
  release: () => Promise<void>;
}> {
  if (process.platform !== 'win32') return { acquired: false, alive: () => false, release: async () => {} };
  const child = start('mutex');
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return new Promise((done, fail) => {
    let buffer = '',
      settled = false;
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Monitor mutex unavailable'));
    }, 10000);
    child.on('error', () => {
      clearTimeout(timer);
      if (!settled) fail(new Error('Monitor mutex unavailable'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (settled || !buffer.includes('\n')) return;
      clearTimeout(timer);
      try {
        const { acquired } = JSON.parse(buffer.trim());
        if (typeof acquired !== 'boolean') throw new Error();
        settled = true;
        if (!acquired) child.stdin.end();
        done({
          acquired,
          alive: () => acquired && child.exitCode === null && !child.killed,
          release: async () => {
            if (child.exitCode !== null) return;
            await new Promise<void>((resolve) => {
              child.once('close', () => resolve());
              child.stdin.end('\n');
            });
          },
        });
      } catch {
        child.kill();
        fail(new Error('Invalid monitor mutex response'));
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) fail(new Error('Monitor mutex closed'));
    });
  });
}
