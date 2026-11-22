import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createBackup } from "../src/backup.ts";
import { openDatabase } from "../src/db.ts";
import { decryptSecret, encryptSecret, ensureMasterKey } from "../src/vault.ts";

test("backup includes a consistent WAL snapshot and key without overwriting existing data", async () => {
  const root=await mkdtemp(join(tmpdir(),"postmote-backup-"));
  const source=join(root,"source"), destination=join(root,"backup");
  await ensureMasterKey(source);
  const db=await openDatabase(source);
  try {
    const now=new Date().toISOString(), secret=await encryptSecret(source,"box","mailbox-secret");
    db.query("INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at) VALUES('box','Box','test@example.test','localhost',993,'tls','test',?,120,?,?)").run(secret,now,now);
    expect(await createBackup(source,destination)).toBe(destination);
    const snapshot=new Database(join(destination,"postmote.db"),{readonly:true});
    try { const row=snapshot.query("SELECT encrypted_secret FROM mailboxes WHERE id='box'").get() as {encrypted_secret:string}; expect(await decryptSecret(destination,"box",row.encrypted_secret)).toBe("mailbox-secret"); } finally { snapshot.close(); }
    if (process.platform!=="win32") { expect((await stat(destination)).mode & 0o777).toBe(0o700); expect((await stat(join(destination,"master.key"))).mode & 0o777).toBe(0o600); expect((await stat(join(destination,"postmote.db"))).mode & 0o777).toBe(0o600); }
    await expect(createBackup(source,destination)).rejects.toThrow();
    await expect(createBackup(source,"relative-directory")).rejects.toThrow();
    expect(await decryptSecret(destination,"box",secret)).toBe("mailbox-secret");
  } finally { db.close(); await rm(root,{recursive:true,force:true}); }
});
