import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, mkdir, link, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearHistory,
  insertVisits,
  chromeTime,
  modifyHistory,
  cleanCookiesAndCache,
} from '../packages/dsh-cicada/src/host/browser.ts';
import { WindowsActions, matchApp } from '../packages/dsh-cicada/src/host/actions.ts';
import { protectedReason, shredFile, shredFolder } from '../packages/dsh-cicada/src/host/folders.ts';
import { generateHistory, dripHistory } from '../packages/dsh-cicada/src/shared/history.ts';
import { defaults } from '../packages/dsh-cicada/src/shared/config.ts';
import * as windows from '../packages/dsh-cicada/src/host/windows.ts';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-cicada-test-'));
  temporary.push(path);
  return path;
}
function schema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visit_count INTEGER,typed_count INTEGER,last_visit_time INTEGER,hidden INTEGER); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER,transition INTEGER,visit_duration INTEGER,external_referrer_url TEXT);',
  );
}
function clusterSchema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE clusters(cluster_id INTEGER PRIMARY KEY,label TEXT NOT NULL,raw_label TEXT NOT NULL); CREATE TABLE clusters_and_visits(cluster_id INTEGER,visit_id INTEGER,url_for_deduping TEXT); CREATE TABLE cluster_keywords(cluster_id INTEGER,keyword TEXT,type INTEGER,score REAL,collections TEXT,PRIMARY KEY(cluster_id,keyword));',
  );
}
describe('synthetic history', () => {
  it.each(['worker', 'student', 'designer', 'trader', 'gamer', 'lifestyle'] as const)(
    'generates stable valid past records for %s',
    (persona) => {
      const now = Date.now(),
        rows = generateHistory(persona, 7, now);
      expect(rows).toEqual(generateHistory(persona, 7, now));
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every(
          (v) =>
            v.at < now &&
            v.dwellSeconds >= 45 &&
            v.dwellSeconds <= 900 &&
            new URL(v.url).protocol === 'https:',
        ),
      ).toBe(true);
      expect(rows.map((r) => r.at)).toEqual(rows.map((r) => r.at).sort((a, b) => a - b));
    },
  );
  it('filters sensitive synthetic URLs and titles', () => {
    const rows = generateHistory('worker', 7, Date.now(), 42, ['github', 'Python']);
    expect(rows.every((r) => !/github|python/i.test(r.url + r.title))).toBe(true);
  });
  it('limits progressive injection to 12 visits', () => {
    expect(dripHistory('worker', Date.now(), 4, []).length).toBeLessThanOrEqual(12);
  });
  it('preserves Chrome timestamps beyond JS safe integers', () => {
    expect(chromeTime(0)).toBe(11644473600000000n);
  });
});
describe('browser database contracts using only synthetic SQLite', () => {
  it('updates URL counts consistently and handles interleaved sessions', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    const rows = generateHistory('worker', 7, Date.now());
    db.exec('BEGIN');
    insertVisits(db, rows);
    db.exec('COMMIT');
    expect(Number(db.prepare('SELECT SUM(visit_count) AS n FROM urls').get()!.n)).toBe(rows.length);
    expect(Number(db.prepare('SELECT SUM(typed_count) AS n FROM urls').get()!.n)).toBe(
      new Set(rows.map((r) => r.session)).size,
    );
    db.close();
  });
  it('selectively deletes linked annotations and downloads without removing unrelated records', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    db.exec(
      "INSERT INTO urls VALUES(1,'https://sensitive.invalid','secret',1,1,0,0),(2,'https://safe.invalid','safe',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''),(20,2,0,0,0,''); CREATE TABLE content_annotations(visit_id INTEGER,search_terms TEXT); INSERT INTO content_annotations VALUES(10,'x'),(20,'neutral'); CREATE TABLE downloads(id INTEGER,target_path TEXT); CREATE TABLE downloads_url_chains(id INTEGER,url TEXT); INSERT INTO downloads VALUES(4,'x'); INSERT INTO downloads_url_chains VALUES(4,'https://secret.invalid');",
    );
    expect(clearHistory(db, ['secret'])).toBe(1);
    expect(db.prepare('SELECT id FROM urls').all()).toEqual([{ id: 2 }]);
    expect(db.prepare('SELECT visit_id FROM content_annotations').all()).toEqual([{ visit_id: 20 }]);
    expect(db.prepare('SELECT * FROM downloads').all()).toEqual([]);
    db.close();
  });
  it('full clearing tolerates missing optional Chromium tables', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    insertVisits(db, generateHistory('gamer', 2, Date.now()));
    expect(clearHistory(db, [])).toBeGreaterThan(0);
    expect(db.prepare('SELECT * FROM urls').all()).toEqual([]);
    db.close();
  });
  it('removes affected orphan clusters and scrubs sensitive metadata without deleting mixed visits', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    clusterSchema(db);
    db.exec(
      "INSERT INTO urls VALUES(1,'https://secret.invalid','secret',1,1,0,0),(2,'https://safe.invalid','safe',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''),(20,2,0,0,0,''); INSERT INTO clusters VALUES(1,'SeCrEt journey','safe label'),(2,'orphan','orphan'),(3,'safe','safe'),(4,'safe label','SECRET raw label'); INSERT INTO clusters_and_visits VALUES(1,10,''),(1,20,''),(2,10,''),(3,20,''),(4,20,''); INSERT INTO cluster_keywords VALUES(1,'SECRET topic',0,1,''),(1,'safe topic',0,1,''),(2,'safe orphan topic',0,1,''),(3,'safe topic',0,1,''),(4,'secret keyword',0,1,'');",
    );
    expect(clearHistory(db, [' SECRET '])).toBe(1);
    expect(db.prepare('SELECT id FROM visits').all()).toEqual([{ id: 20 }]);
    expect(db.prepare('SELECT cluster_id,visit_id FROM clusters_and_visits').all()).toEqual([
      { cluster_id: 1, visit_id: 20 },
      { cluster_id: 3, visit_id: 20 },
      { cluster_id: 4, visit_id: 20 },
    ]);
    expect(db.prepare('SELECT * FROM clusters ORDER BY cluster_id').all()).toEqual([
      { cluster_id: 1, label: '', raw_label: 'safe label' },
      { cluster_id: 3, label: 'safe', raw_label: 'safe' },
      { cluster_id: 4, label: 'safe label', raw_label: '' },
    ]);
    expect(db.prepare('SELECT cluster_id,keyword FROM cluster_keywords ORDER BY cluster_id').all()).toEqual([
      { cluster_id: 1, keyword: 'safe topic' },
      { cluster_id: 3, keyword: 'safe topic' },
    ]);
    db.close();
  });
  it('captures clusters linked only through sensitive association text before unlinking them', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    clusterSchema(db);
    db.exec(
      "INSERT INTO urls VALUES(1,'https://safe.invalid','safe',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''); INSERT INTO clusters VALUES(1,'neutral','neutral'); INSERT INTO clusters_and_visits VALUES(1,10,'https://secret.invalid'); INSERT INTO cluster_keywords VALUES(1,'neutral',0,1,'');",
    );
    expect(clearHistory(db, ['secret'])).toBe(0);
    expect(db.prepare('SELECT * FROM clusters').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM cluster_keywords').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM urls').all()).toEqual([{ id: 1 }]);
    expect(db.prepare('SELECT id FROM visits').all()).toEqual([{ id: 10 }]);
    db.close();
  });
  it.each(['clusters', 'clusters_and_visits', 'cluster_keywords'])(
    'targeted cluster cleanup tolerates a missing %s table',
    (table) => {
      const db = new DatabaseSync(':memory:');
      schema(db);
      clusterSchema(db);
      db.exec(
        "INSERT INTO urls VALUES(1,'https://secret.invalid','secret',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''); INSERT INTO clusters VALUES(1,'secret','secret'); INSERT INTO clusters_and_visits VALUES(1,10,''); INSERT INTO cluster_keywords VALUES(1,'secret',0,1,'');",
      );
      db.exec(`DROP TABLE "${table}"`);
      expect(clearHistory(db, ['secret'])).toBe(1);
      if (table !== 'clusters')
        expect(db.prepare("SELECT * FROM clusters WHERE label LIKE '%secret%'").all()).toEqual([]);
      if (table !== 'cluster_keywords')
        expect(db.prepare("SELECT * FROM cluster_keywords WHERE keyword LIKE '%secret%'").all()).toEqual([]);
      db.close();
    },
  );
  it('supports cluster schemas without optional text columns', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    db.exec(
      "CREATE TABLE clusters(cluster_id INTEGER PRIMARY KEY); CREATE TABLE clusters_and_visits(cluster_id INTEGER,visit_id INTEGER); CREATE TABLE cluster_keywords(cluster_id INTEGER); INSERT INTO urls VALUES(1,'https://secret.invalid','secret',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''); INSERT INTO clusters VALUES(1); INSERT INTO clusters_and_visits VALUES(1,10); INSERT INTO cluster_keywords VALUES(1);",
    );
    expect(clearHistory(db, ['secret'])).toBe(1);
    expect(db.prepare('SELECT * FROM clusters').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM cluster_keywords').all()).toEqual([]);
    db.close();
  });
  it('rolls back cluster deletion and metadata edits when a later insert fails', async () => {
    const root = await directory(),
      path = join(root, 'History');
    const db = new DatabaseSync(path);
    schema(db);
    clusterSchema(db);
    db.exec(
      "INSERT INTO urls VALUES(1,'https://secret.invalid','secret',1,1,0,0),(2,'https://safe.invalid','safe',1,1,0,0); INSERT INTO visits VALUES(10,1,0,0,0,''),(20,2,0,0,0,''); INSERT INTO clusters VALUES(1,'secret mixed','secret mixed'),(2,'orphan','orphan'); INSERT INTO clusters_and_visits VALUES(1,10,''),(1,20,''),(2,10,''); INSERT INTO cluster_keywords VALUES(1,'secret',0,1,''),(2,'safe',0,1,''); CREATE TRIGGER reject_insert BEFORE INSERT ON visits BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    const before = ['urls', 'visits', 'clusters', 'clusters_and_visits', 'cluster_keywords'].map((table) =>
      db.prepare(`SELECT * FROM "${table}"`).all(),
    );
    db.close();
    await expect(modifyHistory(path, ['secret'], generateHistory('worker', 2, Date.now()))).rejects.toThrow();
    const restored = new DatabaseSync(path);
    expect(
      ['urls', 'visits', 'clusters', 'clusters_and_visits', 'cluster_keywords'].map((table) =>
        restored.prepare(`SELECT * FROM "${table}"`).all(),
      ),
    ).toEqual(before);
    restored.close();
    expect((await readdir(root)).some((name) => name.endsWith('.bak'))).toBe(true);
  });
  it('creates and removes only its own successful backup on temporary databases', async () => {
    const root = await directory(),
      path = join(root, 'History');
    const db = new DatabaseSync(path);
    schema(db);
    db.close();
    const old = `${path}.cicada.old.bak`;
    await writeFile(old, 'old recovery data');
    const result = await modifyHistory(path, [], generateHistory('worker', 2, Date.now()));
    expect(result.backupRemoved).toBe(true);
    expect(await readFile(old, 'utf8')).toBe('old recovery data');
  });
  it('retains a recovery backup when history insertion fails and rolls back deletion', async () => {
    const root = await directory(),
      path = join(root, 'History');
    const db = new DatabaseSync(path);
    schema(db);
    db.exec(
      "INSERT INTO urls VALUES(1,'https://keep.invalid','keep',1,1,0,0); CREATE TRIGGER reject_insert BEFORE INSERT ON visits BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    db.close();
    await expect(modifyHistory(path, [], generateHistory('worker', 2, Date.now()))).rejects.toThrow();
    expect((await readdir(root)).some((n) => n.endsWith('.bak'))).toBe(true);
    const restored = new DatabaseSync(path);
    expect(restored.prepare('SELECT url FROM urls').get()!.url).toBe('https://keep.invalid');
    restored.close();
  });
  it('rejects hardlinked history before opening the database', async () => {
    const root = await directory(),
      path = join(root, 'History');
    const db = new DatabaseSync(path);
    schema(db);
    db.close();
    await link(path, join(root, 'other'));
    await expect(modifyHistory(path, [], [])).rejects.toThrow('Hardlinked');
  });
  it('rejects a Cookies ancestor junction before modifying its outside target', async () => {
    const root = await directory(),
      outside = await directory();
    const db = new DatabaseSync(join(outside, 'Cookies'));
    db.exec("CREATE TABLE cookies(value TEXT); INSERT INTO cookies VALUES('keep');");
    db.close();
    await symlink(outside, join(root, 'Network'), 'junction');
    await expect(cleanCookiesAndCache(root)).rejects.toThrow('Reparse');
    const check = new DatabaseSync(join(outside, 'Cookies'));
    expect(check.prepare('SELECT value FROM cookies').get()!.value).toBe('keep');
    check.close();
  });
  it('retains Cookies backups on an incompatible schema', async () => {
    const root = await directory();
    const db = new DatabaseSync(join(root, 'Cookies'));
    db.exec('CREATE TABLE other(x)');
    db.close();
    await expect(cleanCookiesAndCache(root)).rejects.toThrow();
    expect((await readdir(root)).some((n) => n.endsWith('.bak'))).toBe(true);
  });
});
describe('Windows action safeguards', () => {
  it('never invokes Windows helpers for any drill level', async () => {
    const call = vi.spyOn(windows, 'windowsCall').mockRejectedValue(new Error('must not run'));
    const runner = new WindowsActions([]),
      config = defaults();
    config.targets = { folders: ['C:\\fixture'], apps: ['Fixture app'], keywords: ['fixture'] };
    config.actions.cleanEventLogs = true;
    config.actions.cleanCookies = true;
    for (const level of [1, 2, 3, 4] as const) await runner.run(config, level, false);
    expect(call).not.toHaveBeenCalled();
  });
  it.each(['C:\\', '\\\\?\\C:\\', 'relative\\data', '\\\\server\\share'])('protects %s', (path) => {
    expect(protectedReason(path)).not.toBeNull();
  });
  it('protects extended system paths and Harness ancestors', () => {
    expect(protectedReason('\\\\?\\C:\\Windows\\System32')).not.toBeNull();
    expect(protectedReason('D:\\Apps', ['D:\\Apps\\Harness'])).not.toBeNull();
  });
  it.each(['C:\\target:stream', 'C:\\Windows.\\data', 'C:\\Windows \\data'])(
    'rejects ambiguous Windows path %s',
    (path) => {
      expect(protectedReason(path)).not.toBeNull();
    },
  );
  it('does not confuse Go with Google', () => {
    expect(matchApp('Go', ['Google Chrome', 'Go'])).toBe('Go');
    expect(matchApp('Go', ['Google Chrome'])).toBeNull();
  });
  it.each([
    ['微信', '企业微信'],
    ['微信', '微信企业版'],
    ['编辑器', '超级编辑器'],
    ['Editor', '超级Editor'],
    ['Go', 'Go语言'],
    ['Cafe', 'Cafe\u0301 Editor'],
    ['Editor', 'Editor_tools'],
  ])('does not expand %s into the different Unicode identity %s', (target, name) => {
    expect(matchApp(target, [name])).toBeNull();
  });
  it.each([
    ['微信', '微信 (64-bit)'],
    ['Editor', 'EDITOR 2026'],
    ['C++', 'C++ (x64)'],
  ])('preserves delimited whole-name matching for %s', (target, name) => {
    expect(matchApp(target, [name])).toBe(name);
  });
  it('does not match an empty uninstall target', () => {
    expect(matchApp('', ['Fixture app'])).toBeNull();
  });
  it('rejects ambiguous uninstall matches', () => {
    expect(() => matchApp('Editor', ['Editor A', 'Editor B'])).toThrow();
    expect(() => matchApp('微信', ['微信 (x86)', '微信 (x64)'])).toThrow('Ambiguous');
  });
  it('never passes a different Chinese registry identity to the mocked uninstaller', async () => {
    const call = vi.spyOn(windows, 'windowsCall').mockImplementation(async (operation) => {
      if (operation === 'apps') return { names: ['企业微信'] } as never;
      if (operation === 'uninstall') return { ok: true } as never;
      throw new Error('Unexpected operation');
    });
    const config = defaults();
    config.targets.apps = ['微信'];
    const report = await new WindowsActions([]).run(config, 4, true);
    expect(call).toHaveBeenCalledWith('uninstall', { name: '微信' }, 930000);
    expect(call).not.toHaveBeenCalledWith('uninstall', { name: '企业微信' }, expect.anything());
    expect(report[0]!.status).toBe('completed');
  });
  it('does not invoke the mocked uninstaller for ambiguous Unicode identities', async () => {
    const call = vi
      .spyOn(windows, 'windowsCall')
      .mockResolvedValue({ names: ['微信 (x86)', '微信 (x64)'] } as never);
    const config = defaults();
    config.targets.apps = ['微信'];
    const report = await new WindowsActions([]).run(config, 4, true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(report[0]!.status).toBe('failed');
  });
  it('does not overwrite data shared through hard links', async () => {
    const root = await directory(),
      a = join(root, 'a'),
      b = join(root, 'b');
    await writeFile(a, 'unchanged');
    await link(a, b);
    expect(await shredFile(a)).toBe(false);
    expect(await readFile(b, 'utf8')).toBe('unchanged');
  });
  it('never follows a directory junction to outside targets', async () => {
    const root = await directory(),
      target = await directory(),
      own = join(root, 'own');
    await mkdir(own);
    await writeFile(join(target, 'keep'), 'safe');
    await symlink(target, join(own, 'junction'), 'junction');
    await shredFolder(own, []);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('safe');
  });
  it('dry-run never touches a configured nonexistent or protected target', async () => {
    const config = defaults();
    config.targets = { folders: ['C:\\Windows'], apps: ['Nonexistent test application'], keywords: [] };
    const runner = new WindowsActions([]);
    const report = await runner.run(config, 4, false);
    expect(report[0]!.detail).toContain('演练');
    await runner.run(config, 1, false);
  });
});
