import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Visit } from '../shared/types.ts';
import { assertPlainPath, shredFile } from './folders.ts';

const TABLES = [
  'visit_source',
  'content_annotations',
  'clusters_and_visits',
  'cluster_visit_duplicates',
  'cluster_keywords',
  'clusters',
  'journey_continuation_queries',
  'journeys',
  'segment_usage',
  'segment_details',
  'segments',
  'keyword_search_terms',
  'downloads_slices',
  'downloads_url_chains',
  'downloads',
  'visited_links',
  'visits',
  'urls',
];
async function assertDatabasePath(path: string): Promise<void> {
  await assertPlainPath(path, true);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(`${path}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    await assertPlainPath(`${path}${suffix}`, true);
  }
}
export function chromeTime(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * 1000n + 11644473600000000n;
}
function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((r) => String(r.name)),
  );
}
function exists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function checkpoint(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (row && Number(row.busy) !== 0) throw new Error('Browser WAL remains busy; recovery backup retained');
}
function removeIds(db: DatabaseSync, table: string, column: string, ids: Set<number>): void {
  if (!exists(db, table) || !columns(db, table).has(column)) return;
  const statement = db.prepare(`DELETE FROM "${table}" WHERE "${column}"=?`);
  for (const id of ids) statement.run(id);
}
function matchingIds(
  db: DatabaseSync,
  table: string,
  id: string,
  texts: string[],
  keywords: string[],
): Set<number> {
  if (!exists(db, table)) return new Set();
  const cols = columns(db, table),
    usable = texts.filter((c) => cols.has(c));
  if (!cols.has(id) || !usable.length) return new Set();
  const out = new Set<number>();
  for (const row of db
    .prepare(`SELECT "${id}", ${usable.map((c) => `"${c}"`).join(',')} FROM "${table}"`)
    .iterate()) {
    const text = usable
      .map((c) => row[c] ?? '')
      .join(' ')
      .toLocaleLowerCase();
    if (keywords.some((k) => text.includes(k))) out.add(Number(row[id]));
  }
  return out;
}
function linked(db: DatabaseSync, table: string, id: string, fk: string, ids: Set<number>): Set<number> {
  if (!exists(db, table)) return new Set();
  const cols = columns(db, table);
  if (!cols.has(id) || !cols.has(fk)) return new Set();
  return new Set(
    db
      .prepare(`SELECT "${id}", "${fk}" FROM "${table}"`)
      .all()
      .filter((r) => ids.has(Number(r[fk])))
      .map((r) => Number(r[id])),
  );
}
export function clearHistory(db: DatabaseSync, keywords: string[]): number {
  const normalized = keywords.map((k) => k.trim().toLocaleLowerCase()).filter(Boolean);
  if (!normalized.length) {
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM urls').get()!.n);
    for (const table of TABLES) if (exists(db, table)) db.exec(`DELETE FROM "${table}"`);
    return count;
  }
  const urls = matchingIds(db, 'urls', 'id', ['url', 'title'], normalized);
  const visits = linked(db, 'visits', 'id', 'url', urls);
  for (const id of matchingIds(db, 'visits', 'id', ['external_referrer_url'], normalized)) visits.add(id);
  for (const table of [
    'content_annotations',
    'clusters_and_visits',
    'cluster_visit_duplicates',
    'visit_source',
  ])
    removeIds(db, table, table === 'visit_source' ? 'id' : 'visit_id', visits);
  removeIds(
    db,
    'content_annotations',
    'visit_id',
    matchingIds(
      db,
      'content_annotations',
      'visit_id',
      ['search_normalized_url', 'search_terms', 'alternative_title'],
      normalized,
    ),
  );
  removeIds(
    db,
    'clusters_and_visits',
    'visit_id',
    matchingIds(
      db,
      'clusters_and_visits',
      'visit_id',
      ['url_for_deduping', 'normalized_url', 'url_for_display'],
      normalized,
    ),
  );
  const segments = linked(db, 'segments', 'id', 'url_id', urls);
  for (const table of ['segment_usage', 'segment_details']) removeIds(db, table, 'segment_id', segments);
  removeIds(db, 'segments', 'url_id', urls);
  removeIds(db, 'visited_links', 'link_url_id', urls);
  removeIds(db, 'visited_links', 'url', urls);
  removeIds(
    db,
    'visited_links',
    'id',
    matchingIds(db, 'visited_links', 'id', ['top_level_url', 'frame_url', 'url'], normalized),
  );
  const downloads = matchingIds(
    db,
    'downloads',
    'id',
    ['target_path', 'tab_url', 'tab_referrer_url', 'site_url', 'referrer'],
    normalized,
  );
  for (const id of matchingIds(db, 'downloads_url_chains', 'id', ['url'], normalized)) downloads.add(id);
  removeIds(db, 'downloads_slices', 'download_id', downloads);
  removeIds(db, 'downloads_url_chains', 'id', downloads);
  removeIds(db, 'downloads', 'id', downloads);
  removeIds(db, 'keyword_search_terms', 'url_id', urls);
  removeIds(db, 'visits', 'id', visits);
  removeIds(db, 'visits', 'url', urls);
  removeIds(db, 'urls', 'id', urls);
  return urls.size;
}
export function insertVisits(db: DatabaseSync, visits: Visit[]): number {
  const visitColumns = columns(db, 'visits');
  const lastBySession = new Set<number>();
  for (const visit of visits) {
    let row = db.prepare('SELECT id FROM urls WHERE url=?').get(visit.url);
    if (!row) {
      db.prepare(
        'INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden) VALUES(?,?,0,0,?,0)',
      ).run(visit.url, visit.title, chromeTime(visit.at));
      row = db.prepare('SELECT id FROM urls WHERE url=?').get(visit.url);
    }
    const first = !lastBySession.has(visit.session);
    lastBySession.add(visit.session);
    const cols = ['url', 'visit_time', 'transition'];
    const values: (number | bigint)[] = [
      Number(row!.id),
      chromeTime(visit.at),
      first ? 0x30000001 : 0x30000000,
    ];
    if (visitColumns.has('visit_duration')) {
      cols.push('visit_duration');
      values.push(BigInt(visit.dwellSeconds) * 1000000n);
    }
    db.prepare(`INSERT INTO visits(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(
      ...values,
    );
    db.prepare(
      'UPDATE urls SET visit_count=COALESCE(visit_count,0)+1, typed_count=COALESCE(typed_count,0)+?, last_visit_time=MAX(COALESCE(last_visit_time,0),?) WHERE id=?',
    ).run(first ? 1 : 0, chromeTime(visit.at), Number(row!.id));
  }
  return visits.length;
}
export async function modifyHistory(
  path: string,
  keywords: string[] | null,
  visits: Visit[],
): Promise<{ cleared: number; inserted: number; backupRemoved: boolean }> {
  await assertDatabasePath(path);
  const bak = `${path}.cicada.${randomUUID()}.bak`;
  const db = new DatabaseSync(path, { timeout: 5000 });
  let cleared = 0,
    inserted = 0,
    complete = false;
  try {
    if (!exists(db, 'urls') || !exists(db, 'visits')) throw new Error('Unsupported browser schema');
    await backup(db, bak);
    db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    try {
      if (keywords !== null) cleared = clearHistory(db, keywords);
      inserted = insertVisits(db, visits);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    checkpoint(db);
    db.exec('VACUUM');
    checkpoint(db);
    complete = true;
  } finally {
    db.close();
  }
  return { cleared, inserted, backupRemoved: complete && (await shredFile(bak)) };
}
export async function browserProfiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  await assertPlainPath(root);
  const result: string[] = [];
  for (const name of names.sort()) {
    if (['System Profile', 'Guest Profile'].includes(name)) continue;
    const profile = join(root, name);
    try {
      const st = await lstat(profile),
        history = await lstat(join(profile, 'History'));
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        !history.isFile() ||
        history.isSymbolicLink() ||
        history.nlink !== 1
      )
        continue;
      const actual = await realpath(profile),
        base = await realpath(root);
      if (
        !resolve(actual)
          .toLowerCase()
          .startsWith(`${resolve(base).toLowerCase()}\\`)
      )
        continue;
      result.push(profile);
    } catch {
      /* Profiles disappearing during discovery are skipped. */
    }
  }
  return result;
}
export async function cleanCookiesAndCache(profile: string): Promise<number> {
  await assertPlainPath(profile);
  let count = 0;
  for (const relative of ['Network/Cookies', 'Cookies']) {
    const path = join(profile, relative);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    await assertDatabasePath(path);
    const db = new DatabaseSync(path, { timeout: 5000 }),
      bak = `${path}.cicada.${randomUUID()}.bak`;
    try {
      await backup(db, bak);
      db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM cookies; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      checkpoint(db);
      db.exec('VACUUM');
      checkpoint(db);
    } finally {
      db.close();
    }
    if (!(await shredFile(bak))) throw new Error('Cookie backup retained');
    count++;
  }
  const walk = async (path: string): Promise<void> => {
    await assertPlainPath(path, true);
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error('Cache reparse point rejected');
    if (st.isDirectory()) {
      for (const child of await readdir(path)) await walk(join(path, child));
    } else if (st.isFile()) {
      await rm(path);
      count++;
    }
  };
  for (const relative of ['Cache/Cache_Data', 'Code Cache', 'GPUCache', 'Media Cache']) {
    const path = join(profile, relative);
    try {
      await lstat(path);
    } catch {
      continue;
    }
    await walk(path);
  }
  return count;
}
