import { lstat, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, win32 } from 'node:path';

export async function assertPlainPath(path: string, singleLink = false): Promise<void> {
  let current = resolve(path);
  const leaf = await lstat(current);
  if (singleLink && leaf.isFile() && leaf.nlink !== 1) throw new Error('Hardlinked target rejected');
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Reparse ancestor rejected');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function canonicalPath(raw: string): string {
  const path = raw.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return win32
    .normalize(path)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}
export function protectedReason(raw: string, extraRoots: string[] = []): string | null {
  const path = canonicalPath(raw);
  if (
    /[:]/.test(path.slice(2)) ||
    raw.split(/[\\/]/).some((part) => /[. ]$/.test(part) && part !== '..' && part !== '.')
  )
    return '特殊流或不规范路径';
  if (!win32.isAbsolute(path) || path.startsWith('\\\\') || /^[a-z]:$/i.test(path))
    return '根目录、相对路径或网络路径';
  const subtree = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    ...extraRoots,
  ].filter((s): s is string => Boolean(s));
  const exact = [
    process.env.USERPROFILE,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE && win32.dirname(process.env.USERPROFILE),
  ].filter((s): s is string => Boolean(s));
  if (exact.some((root) => path === canonicalPath(root))) return '用户或数据根目录';
  if (
    subtree.some((root) => {
      const r = canonicalPath(root);
      return path === r || path.startsWith(`${r}\\`) || r.startsWith(`${path}\\`);
    })
  )
    return '系统、Harness、插件及其上级目录';
  return null;
}
export async function shredFile(path: string): Promise<boolean> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    await unlink(path);
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.nlink > 1) {
    await unlink(path);
    return false;
  }
  await assertPlainPath(path, true);
  // Revalidate the opened identity so a replaced link cannot redirect overwrites.
  const handle = await open(path, 'r+');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || !opened.isFile())
      throw new Error('File identity changed');
    for (let pass = 0; pass < 3; pass++) {
      const bytes = randomBytes(Math.min(1024 * 1024, Math.max(1, stat.size)));
      for (let position = 0; position < stat.size;) {
        const count = Math.min(bytes.length, stat.size - position);
        const written = await handle.write(bytes, 0, count, position);
        if (!written.bytesWritten) throw new Error('Short write');
        position += written.bytesWritten;
      }
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  const final = await lstat(path);
  if (final.ino !== stat.ino || final.dev !== stat.dev || final.nlink !== 1 || final.isSymbolicLink())
    throw new Error('File identity changed before removal');
  await assertPlainPath(path, true);
  const ghost = join(dirname(path), `.cicada-${randomUUID()}`);
  await rename(path, ghost);
  await unlink(ghost);
  return true;
}
export async function shredFolder(
  root: string,
  extraRoots: string[],
): Promise<{ count: number; failed: number }> {
  if (!isAbsolute(root) || protectedReason(root, extraRoots)) throw new Error('Protected target');
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    await unlink(root);
    return { count: 0, failed: 1 };
  }
  if (!rootStat.isDirectory()) throw new Error('Not a folder');
  await assertPlainPath(root);
  const resolved = await realpath(root);
  if (protectedReason(resolved, extraRoots) || parse(resolved).root === resolved)
    throw new Error('Protected resolved target');
  let count = 0,
    failed = 0;
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      try {
        await unlink(path);
      } catch {
        try {
          await rmdir(path);
        } catch {
          failed++;
        }
      }
      return;
    }
    const actual = await realpath(path);
    const base = resolve(resolved).toLowerCase(),
      current = resolve(actual).toLowerCase();
    if (current !== base && !current.startsWith(`${base}\\`) && !current.startsWith(`${base}/`)) {
      failed++;
      return;
    }
    if (stat.isDirectory()) {
      await assertPlainPath(path);
      for (const name of await readdir(path)) await visit(join(path, name));
      try {
        await rmdir(path);
      } catch {
        failed++;
      }
    } else {
      try {
        if (await shredFile(path)) count++;
        else failed++;
      } catch {
        failed++;
      }
    }
  };
  await visit(root);
  return { count, failed };
}
