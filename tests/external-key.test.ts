import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db.ts";
import { createBackup } from "../src/backup.ts";
import { decryptSecret, encryptSecret, ensureMasterKey, masterKeyPath } from "../src/vault.ts";

test("an external key works with backup and a missing key never replaces encrypted data", async () => {
  const root=await mkdtemp(join(tmpdir(),"postmote-external-key-"));
  const data=join(root,"data"), key=join(root,"external.key"), backup=join(root,"backup");
  const prior=process.env.POSTMOTE_MASTER_KEY_FILE;
  process.env.POSTMOTE_MASTER_KEY_FILE=key;
  try {
    expect(masterKeyPath(data)).toBe(key);
    await ensureMasterKey(data);
    const secret=await encryptSecret(data,"box","secret");
    const db=await openDatabase(data), now=new Date().toISOString();
    try { db.query("INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at) VALUES('box','Box','test@example.test','localhost',993,'tls','test',?,120,?,?)").run(secret,now,now); } finally { db.close(); }
    await createBackup(data,backup);
    expect(await readFile(join(backup,"master.key"))).toEqual(await readFile(key));
    delete process.env.POSTMOTE_MASTER_KEY_FILE;
    expect(await decryptSecret(backup,"box",secret)).toBe("secret");
    await expect(ensureMasterKey(data)).rejects.toThrow("Master key is missing");
    process.env.POSTMOTE_MASTER_KEY_FILE=key;
    expect(await decryptSecret(data,"box",secret)).toBe("secret");
    await unlink(key);
    await expect(ensureMasterKey(data)).rejects.toThrow("Master key is missing");
  } finally {
    if (prior===undefined) delete process.env.POSTMOTE_MASTER_KEY_FILE; else process.env.POSTMOTE_MASTER_KEY_FILE=prior;
    await rm(root,{recursive:true,force:true});
  }
});
