import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const helpers = [];
async function helper() {
  const child = spawn(
    resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('../packages/dsh-cicada/windows/bridge.ps1', import.meta.url)),
      '-Operation',
      'mutex',
      '-OwnerPid',
      String(process.pid),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise((resolve) => child.once('close', resolve));
  helpers.push({ child, exited });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const acquired = await new Promise((done, fail) => {
    let text = '',
      settled = false;
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Monitor fixture timed out'));
    }, 10000);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) fail(new Error('Monitor fixture closed before reply'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (settled || !text.includes('\n')) return;
      settled = true;
      clearTimeout(timer);
      try {
        const reply = JSON.parse(text.trim());
        assert.equal(typeof reply.acquired, 'boolean');
        done(reply.acquired);
      } catch (error) {
        fail(error);
      }
    });
  });
  return { child, exited, acquired };
}

try {
  const first = await helper();
  assert.equal(first.acquired, true);
  // Only terminate the helper spawned by this fixture, never a user's Host or browser.
  first.child.kill();
  await first.exited;
  const replacement = await helper();
  assert.equal(replacement.acquired, false, 'A live Host identity must prevent takeover after helper loss');
  replacement.child.stdin.end('\n');
  await replacement.exited;
  console.log('Monitor helper loss refused takeover while its owning fixture process remained alive.');
} finally {
  for (const { child, exited } of helpers) {
    if (child.exitCode === null && !child.killed) child.stdin.end('\n');
    await exited;
  }
}
