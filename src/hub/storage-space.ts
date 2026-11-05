import { access, statfs } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import type { HubDatabase } from './database.js';

export async function databaseSpace(db: HubDatabase) {
  return db.serial(async () => ({
    pageSize: (await db.get<{page_size:number}>('PRAGMA page_size'))!.page_size,
    pages: (await db.get<{page_count:number}>('PRAGMA page_count'))!.page_count,
    freePages: (await db.get<{freelist_count:number}>('PRAGMA freelist_count'))!.freelist_count,
    autoVacuum: (await db.get<{auto_vacuum:number}>('PRAGMA auto_vacuum'))!.auto_vacuum,
  }));
}
const reclamation = new WeakMap<HubDatabase,{lastCheckpoint:number;pending:boolean}>();
/** Small writer turns; checkpoint only after actual work, at most every 30s.
 * Old readers may delay truncation, but are never forced out by maintenance. */
export async function reclaimDatabasePages(db: HubDatabase, pages = 128): Promise<void> {
  await db.serial(async () => {
    if ((await db.get<{auto_vacuum:number}>('PRAGMA auto_vacuum'))?.auto_vacuum !== 2) return;
    const state=reclamation.get(db)??{lastCheckpoint:-Infinity,pending:false};reclamation.set(db,state);
    if ((await db.get<{freelist_count:number}>('PRAGMA freelist_count'))!.freelist_count>=128) {
      await db.exec(`PRAGMA incremental_vacuum(${Math.max(1,Math.min(256,Math.floor(pages)))});`);state.pending=true;
    }
    if(state.pending && performance.now()-state.lastCheckpoint>=30_000){
      const checkpoint=await db.get<{log:number;checkpointed:number}>('PRAGMA wal_checkpoint(PASSIVE)');
      state.lastCheckpoint=performance.now();state.pending=!!checkpoint && checkpoint.checkpointed<checkpoint.log;
    }
  });
}
// SQLite's Unix VFS probes these locations in order. Check the first writable
// candidate plus os.tmpdir (the Windows default). Never assume the DB and temp
// files share a volume. This is conservative; SQLITE_TMPDIR can select a larger
// scratch volume for the explicitly invoked offline process.
async function checkVacuumTempSpace(required:number):Promise<void>{
 const candidates=process.platform==='win32'?[os.tmpdir()]:[process.env.SQLITE_TMPDIR,process.env.TMPDIR,'/var/tmp','/usr/tmp','/tmp',process.cwd()];
 for(const candidate of candidates){
  if(!candidate)continue;
  try{await access(candidate,constants.W_OK|constants.X_OK);}catch{continue;}
  const fs=await statfs(candidate),available=fs.bavail*fs.bsize;
  if(available<required)throw new Error(`storage_compaction_temp_space:${required}:${available}`);
  return;
 }
 throw new Error('storage_compaction_temp_directory_unavailable');
}
/** Explicit OFFLINE maintenance only, with the Hub instance lock held by the
 * caller. SQLite owns the atomic VACUUM commit/crash recovery; never rename a
 * live database or its WAL. Disk refusal occurs before changing auto_vacuum. */
export async function compactOfflineDatabase(db: HubDatabase, freeBytes?: number) {
  const before = await databaseSpace(db);
  const fs = freeBytes === undefined ? await statfs(path.dirname(db.file)) : undefined;
  const available = freeBytes ?? fs!.bavail*fs!.bsize;
  const required = before.pages*before.pageSize*2+64*1024*1024;
  if (available<required) throw new Error(`storage_compaction_insufficient_space:${required}:${available}`);
  await checkVacuumTempSpace(before.pages*before.pageSize+64*1024*1024);
  await db.serial(async () => {
    if ((await db.get<{quick_check:string}>('PRAGMA quick_check'))?.quick_check !== 'ok') throw new Error('storage_compaction_integrity_failed');
    const checkpoint = await db.get<{busy:number}>('PRAGMA wal_checkpoint(TRUNCATE)');
    if (checkpoint?.busy) throw new Error('storage_compaction_busy');
    // VACUUM may reassign rowids: an interrupted accounting backfill must
    // restart its scan, while INSERT OR IGNORE preserves its exact counters.
    await db.run('UPDATE event_history_state SET scanned_rowid=0 WHERE ready=0');
    await db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM;');
    if ((await db.get<{quick_check:string}>('PRAGMA quick_check'))?.quick_check !== 'ok') throw new Error('storage_compaction_integrity_failed');
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  return {before,after:await databaseSpace(db)};
}
