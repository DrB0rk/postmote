import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { masterKeyPath } from "./vault.ts";

/** Create a consistent SQLite snapshot and its key in a new private directory. */
export async function createBackup(dataDir:string, target:string) {
  const destination=target.startsWith("~/") ? join(homedir(),target.slice(2)) : target;
  if (!isAbsolute(destination)) throw new Error("Backup destination must be an absolute path or start with ~/.");
  const dbPath=join(dataDir,"postmote.db"), keyPath=masterKeyPath(dataDir);
  await Promise.all([access(dbPath),access(keyPath)]);
  await mkdir(destination,{mode:0o700});
  try {
    if (process.platform!=="win32") await chmod(destination,0o700);
    await copyFile(keyPath,join(destination,"master.key"),constants.COPYFILE_EXCL);
    if (process.platform!=="win32") await chmod(join(destination,"master.key"),0o600);
    const source=new Database(dbPath,{readonly:true});
    try { source.query("VACUUM INTO ?").run(join(destination,"postmote.db")); } finally { source.close(); }
    if (process.platform!=="win32") await chmod(join(destination,"postmote.db"),0o600);
    const snapshot=new Database(join(destination,"postmote.db"),{readonly:true});
    try {
      const check=snapshot.query("PRAGMA quick_check").get() as {quick_check:string} | null;
      if (check?.quick_check!=="ok") throw new Error("Backup integrity check failed.");
    } finally { snapshot.close(); }
    return destination;
  } catch (error) {
    await rm(destination,{recursive:true,force:true});
    throw error;
  }
}
