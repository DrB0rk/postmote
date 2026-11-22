import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { mailboxInputSchema, type MailboxInput } from "../mailbox.ts";
import { dedicatedInbox } from "./permissions.ts";
import { audit } from "./audit.ts";
import { decryptSecret, encryptSecret } from "../vault.ts";

export async function createMailbox(db:Database,dataDir:string,values:MailboxInput, action="mailbox.create") {
  const id=randomBytes(16).toString("hex");
  const encrypted=await encryptSecret(dataDir,id,JSON.stringify({imapPassword:values.password,smtpPassword:values.smtpEnabled ? values.smtpPassword ?? "" : null}));
  const now=new Date().toISOString();
  db.transaction(() => {
    insertMailbox(db,id,values,encrypted,now);
    audit(db,{principalType:"owner",mailboxId:id,action,targetId:id,outcome:"created",time:now});
  })();
  return {id,label:values.label || values.email,email:values.email,approvalRequired:true};
}

function insertMailbox(db:Database,id:string,values:MailboxInput,encrypted:string,now:string) {
  db.query(`INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,encrypted_secret,poll_seconds,created_at,updated_at,sender_name,sender_email,smtp_username,smtp_enabled,mailbox_root)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,values.label || values.email,values.email,values.imapHost,values.imapPort,values.imapSecurity,values.smtpEnabled ? values.smtpHost ?? null : null,values.smtpEnabled ? values.smtpPort ?? null : null,values.smtpEnabled ? values.smtpSecurity ?? null : null,values.username,encrypted,values.pollSeconds,now,now,values.senderName,values.senderEmail ?? values.email,values.smtpEnabled ? values.smtpUsername ?? values.username : null,values.smtpEnabled ? 1 : 0,values.mailboxRoot ?? null);
}

export class AgentInboxSetupDenied extends Error {}
export class AgentInboxExists extends Error {}
export class MailboxForbidden extends Error {}

export async function createAgentInbox(db:Database,dataDir:string,agentId:string,values:MailboxInput,authenticated:()=>boolean) {
  if (!values.smtpEnabled) throw new MailboxInvalid({smtpEnabled:["A dedicated inbox requires SMTP."]});
  const id=randomBytes(16).toString("hex"), now=new Date().toISOString();
  const encrypted=await encryptSecret(dataDir,id,JSON.stringify({imapPassword:values.password,smtpPassword:values.smtpPassword ?? ""}));
  db.transaction(()=>{
    const agent=db.query("SELECT enabled,allow_inbox_setup FROM agents WHERE id=?").get(agentId) as {enabled:number;allow_inbox_setup:number}|null;
    if (!authenticated() || !agent?.enabled || !agent.allow_inbox_setup) throw new AgentInboxSetupDenied();
    if (db.query("SELECT 1 FROM agent_inboxes WHERE agent_id=?").get(agentId)) throw new AgentInboxExists();
    insertMailbox(db,id,values,encrypted,now);
    db.query("INSERT INTO agent_inboxes(agent_id,mailbox_id,created_at) VALUES(?,?,?)").run(agentId,id,now);
    db.query("UPDATE agents SET allow_inbox_setup=0 WHERE id=?").run(agentId);
    audit(db,{principalType:"agent",principalId:agentId,mailboxId:id,action:"agent.inbox.setup",targetId:id,outcome:"created",time:now});
  }).immediate();
  return {id,label:values.label || values.email,email:values.email};
}

export const mailboxPatchSchema = z.object({
  label:z.string().max(80).optional(), email:z.string().max(254).optional(), senderName:z.string().max(100).optional(), senderEmail:z.string().max(254).optional(),
  imapHost:z.string().max(253).optional(), imapPort:z.number().int().optional(), imapSecurity:z.enum(["tls","starttls"]).optional(),
  username:z.string().max(320).optional(), password:z.string().min(1).max(4096).optional(), mailboxRoot:z.string().max(512).optional(), pollSeconds:z.number().int().optional(),
  smtpEnabled:z.boolean().optional(), smtpHost:z.string().max(253).optional(), smtpPort:z.number().int().optional(), smtpSecurity:z.enum(["tls","starttls"]).optional(),
  smtpUsername:z.string().max(320).optional(), smtpPassword:z.string().min(1).max(4096).optional(), useImapForSmtp:z.boolean().optional(),
}).strict();
export type MailboxPatch = z.infer<typeof mailboxPatchSchema>;
export class MailboxNotFound extends Error {}
export class MailboxConflict extends Error {}
export class MailboxInvalid extends Error { constructor(public readonly fields:unknown) { super("Invalid mailbox settings"); } }
export class MailboxSending extends Error {}
export class MailboxAssignedInbox extends Error {}

type ExistingMailbox = { id:string;label:string;email:string;sender_name:string;sender_email:string|null;imap_host:string;imap_port:number;imap_security:"tls"|"starttls";username:string;encrypted_secret:string;mailbox_root:string|null;poll_seconds:number;smtp_enabled:number;smtp_host:string|null;smtp_port:number|null;smtp_security:"tls"|"starttls"|null;smtp_username:string|null;updated_at:string };

export async function updateMailbox(db:Database,dataDir:string,id:string,patch:MailboxPatch,actor?:{agentId:string;authenticated:()=>boolean}) {
  const old=db.query("SELECT * FROM mailboxes WHERE id=?").get(id) as ExistingMailbox | null;
  if (!old) throw new MailboxNotFound();
  const secrets=JSON.parse(await decryptSecret(dataDir,id,old.encrypted_secret)) as {imapPassword:string;smtpPassword:string|null};
  const {useImapForSmtp,...changes}=patch;
  const candidate={label:old.label,email:old.email,senderName:old.sender_name,senderEmail:old.sender_email ?? old.email,imapHost:old.imap_host,imapPort:old.imap_port,imapSecurity:old.imap_security,username:old.username,password:secrets.imapPassword,mailboxRoot:old.mailbox_root ?? undefined,pollSeconds:old.poll_seconds,smtpEnabled:!!old.smtp_enabled,smtpHost:old.smtp_host ?? undefined,smtpPort:old.smtp_port ?? undefined,smtpSecurity:old.smtp_security ?? undefined,smtpUsername:old.smtp_username ?? undefined,smtpPassword:secrets.smtpPassword ?? undefined,...changes};
  if (useImapForSmtp) { candidate.smtpUsername=candidate.username; candidate.smtpPassword=candidate.password; }
  const parsed=mailboxInputSchema.safeParse(candidate);
  if (!parsed.success) throw new MailboxInvalid(parsed.error.flatten().fieldErrors);
  const v=parsed.data, encrypted=await encryptSecret(dataDir,id,JSON.stringify({imapPassword:v.password,smtpPassword:v.smtpEnabled ? v.smtpPassword ?? "" : null}));
  db.transaction(() => {
    if (actor && (!actor.authenticated() || !dedicatedInbox(db,actor.agentId,id))) throw new MailboxForbidden();
    if (db.query("SELECT 1 FROM send_requests WHERE mailbox_id=? AND state='sending' LIMIT 1").get(id)) throw new MailboxSending();
    if (!v.smtpEnabled && db.query("SELECT 1 FROM agent_inboxes WHERE mailbox_id=?").get(id)) throw new MailboxAssignedInbox();
    const changed=db.query(`UPDATE mailboxes SET label=?,email=?,sender_name=?,sender_email=?,imap_host=?,imap_port=?,imap_security=?,username=?,encrypted_secret=?,mailbox_root=?,poll_seconds=?,smtp_enabled=?,smtp_host=?,smtp_port=?,smtp_security=?,smtp_username=?,updated_at=? WHERE id=? AND updated_at=? AND encrypted_secret=?`).run(v.label || v.email,v.email,v.senderName,v.senderEmail ?? v.email,v.imapHost,v.imapPort,v.imapSecurity,v.username,encrypted,v.mailboxRoot || null,v.pollSeconds,v.smtpEnabled ? 1 : 0,v.smtpEnabled ? v.smtpHost ?? null : null,v.smtpEnabled ? v.smtpPort ?? null : null,v.smtpEnabled ? v.smtpSecurity ?? null : null,v.smtpEnabled ? v.smtpUsername ?? v.username : null,new Date().toISOString(),id,old.updated_at,old.encrypted_secret);
    if (!changed.changes) throw new MailboxConflict();
    if (old.imap_host!==v.imapHost || old.imap_port!==v.imapPort || old.imap_security!==v.imapSecurity || old.username!==v.username || (old.mailbox_root ?? "")!==(v.mailboxRoot ?? "")) {
      db.query("DELETE FROM mailbox_poll_locks WHERE mailbox_id=?").run(id);
      db.query("DELETE FROM message_index WHERE mailbox_id=?").run(id);
      db.query("DELETE FROM folder_state WHERE mailbox_id=?").run(id);
    }
    audit(db,{principalType:actor ? "agent" : "owner",principalId:actor?.agentId,mailboxId:id,action:"mailbox.update",targetId:id,outcome:"updated"});
  })();
  return {id,label:v.label || v.email,email:v.email};
}

export function deleteMailbox(db:Database,id:string) {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM mailboxes WHERE id=?").get(id)) throw new MailboxNotFound();
    if (db.query("SELECT 1 FROM send_requests WHERE mailbox_id=? AND state='sending' LIMIT 1").get(id)) throw new MailboxSending();
    db.query("DELETE FROM send_requests WHERE mailbox_id=?").run(id);
    db.query("DELETE FROM drafts WHERE mailbox_id=?").run(id);
    db.query("DELETE FROM mailboxes WHERE id=?").run(id);
    audit(db,{principalType:"owner",mailboxId:id,action:"mailbox.delete",targetId:id,outcome:"deleted"});
    return {deleted:true};
  })();
}
