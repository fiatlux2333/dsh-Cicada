import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { acquireMonitor } from '../packages/dsh-cicada/src/host/windows.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.clearAllMocks();
});

function helper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe('Windows monitor startup using a helper substitute', () => {
  it('accepts a valid reply after the former ten-second startup deadline', async () => {
    const child = helper();
    const waiting = acquireMonitor();
    await vi.advanceTimersByTimeAsync(12000);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write('{"acquired":true}\n');
    const lock = await waiting;
    expect(lock.acquired).toBe(true);
    expect(lock.alive()).toBe(true);
    const releasing = lock.release();
    child.exitCode = 0;
    child.emit('close', 0);
    await releasing;
    await vi.advanceTimersByTimeAsync(30000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('terminates a helper that never replies within thirty seconds', async () => {
    const child = helper();
    const rejection = expect(acquireMonitor()).rejects.toThrow('Monitor mutex startup timed out');
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.stdout.write('{"acquired":true}\n');
    child.emit('close', null, 'SIGTERM');
  });
});
