import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acquireMonitor, windowsSecrets } from '../packages/dsh-cicada/src/host/windows.ts';

if (process.platform !== 'win32') throw new Error('Windows required');
const targets = { folders: [], apps: [], keywords: ['cicada-dpapi-synthetic-fixture'] };
const ciphertext = await windowsSecrets.protect(targets);
assert(!ciphertext.includes(targets.keywords[0]!));
assert.deepEqual(await windowsSecrets.unprotect(ciphertext), targets);
await assert.rejects(() => windowsSecrets.unprotect('invalid-fixture'));
const lock = await acquireMonitor();
try {
  const busy = process.argv.includes('--expect-busy');
  assert.equal(lock.acquired, !busy);
  if (!busy) {
    assert(lock.alive());
    const second = await acquireMonitor();
    try {
      assert.equal(second.acquired, false);
    } finally {
      await second.release();
    }
  }
} finally {
  await lock.release();
}
if (!process.argv.includes('--expect-busy')) {
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./check-monitor-loss.mjs', import.meta.url))],
    {
      windowsHide: true,
      timeout: 30000,
    },
  );
  const recovered = await acquireMonitor();
  try {
    assert.equal(recovered.acquired, true, 'A terminated owner must not block the next Host');
  } finally {
    await recovered.release();
  }
}
console.log(
  'Safe Windows integration passed: synthetic DPAPI roundtrip/corruption, mutex exclusion, helper-loss fencing and dead-owner recovery. No destructive operations executed.',
);
