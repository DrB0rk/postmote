import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { ensureMasterKey, decryptSecret } from "../src/vault.ts";
import { mailboxInputSchema } from "../src/mailbox.ts";
import { createMailbox, updateMailbox, deleteMailbox, mailboxPatchSchema, MailboxConflict, MailboxInvalid, MailboxSending } from "../src/mail/accounts.ts";

test("mailbox updates preserve secrets, reset changed IMAP indexes, and prevent removal during delivery", async () => {
  const dir=await mkdtemp(join(tmpdir(),"postmote-accounts-")); await ensureMasterKey(dir); const db=await openDatabase(dir);
  try {
    const values=mailboxInputSchema.parse({email:"berk@berkderooij.nl",imapHost:"imap.example.test",username:"user",password:"imap-secret",smtpEnabled:true,smtpHost:"smtp.example.test",smtpPort:465,smtpSecurity:"tls",smtpUsername:"smtp-user",smtpPassword:"smtp-secret"});
    const box=await createMailbox(db,dir,values), now=new Date().toISOString();
    db.query("INSERT INTO folder_state(mailbox_id,folder_path,uidvalidity,highest_uid) VALUES(?,'INBOX',42,0)").run(box.id);
    db.query("INSERT INTO message_index(mailbox_id,folder_path,uidvalidity,uid,from_json,to_json,subject,flags_json,snippet,size_bytes) VALUES(?,'INBOX',42,1,'[]','[]','old','[]','',0)").run(box.id);
    db.query("INSERT INTO mailbox_poll_locks(mailbox_id,owner,expires_at) VALUES(?,'test',?)").run(box.id,Date.now()+60000);
    await updateMailbox(db,dir,box.id,{label:"Updated"});
    expect(db.query("SELECT COUNT(*) AS n FROM message_index WHERE mailbox_id=?").get(box.id)).toEqual({n:1});
    const current=db.query("SELECT encrypted_secret FROM mailboxes WHERE id=?").get(box.id) as {encrypted_secret:string};
    expect(JSON.parse(await decryptSecret(dir,box.id,current.encrypted_secret))).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"});
    expect(mailboxPatchSchema.safeParse({password:""}).success).toBe(false);
    await updateMailbox(db,dir,box.id,{imapHost:"other.example.test",username:"other"});
    expect(db.query("SELECT COUNT(*) AS n FROM message_index WHERE mailbox_id=?").get(box.id)).toEqual({n:0});
    expect(db.query("SELECT COUNT(*) AS n FROM folder_state WHERE mailbox_id=?").get(box.id)).toEqual({n:0});
    expect(db.query("SELECT COUNT(*) AS n FROM mailbox_poll_locks WHERE mailbox_id=?").get(box.id)).toEqual({n:0});
    const race=await Promise.allSettled([updateMailbox(db,dir,box.id,{label:"One"}),updateMailbox(db,dir,box.id,{label:"Two"})]);
    expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(race.some(r=>r.status==="rejected" && r.reason instanceof MailboxConflict)).toBe(true);
    db.query("INSERT INTO drafts(id,mailbox_id,mime_fields_json,encrypted_body,revision,created_at,updated_at) VALUES('draft',?,'{}','cipher',1,?,?)").run(box.id,now,now);
    db.query("INSERT INTO send_requests(id,mailbox_id,draft_id,draft_revision,state,approval_expires_at,idempotency_key,created_at,updated_at) VALUES('request',?,'draft',1,'sending',?,'key',?,?)").run(box.id,now,now,now);
    await expect(updateMailbox(db,dir,box.id,{label:"No"})).rejects.toBeInstanceOf(MailboxSending);
    expect(()=>deleteMailbox(db,box.id)).toThrow(MailboxSending);
    db.query("UPDATE send_requests SET state='sent' WHERE id='request'").run();
    await updateMailbox(db,dir,box.id,{smtpEnabled:false});
    await expect(updateMailbox(db,dir,box.id,{smtpEnabled:true})).rejects.toBeInstanceOf(MailboxInvalid);
    expect(deleteMailbox(db,box.id)).toEqual({deleted:true});
    expect(db.query("SELECT COUNT(*) AS n FROM drafts").get()).toEqual({n:0});
    expect(db.query("SELECT COUNT(*) AS n FROM send_requests").get()).toEqual({n:0});
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});
