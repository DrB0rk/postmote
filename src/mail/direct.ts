import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../vault.ts";
import { audit } from "./audit.ts";
import { dedicatedInbox } from "./permissions.ts";
import { sendMail } from "./operations.ts";
import { DELIVERY_LEASE_MS, finishDelivery, holdDeliveryLease } from "./outbox.ts";

export class DirectSendError extends Error {
  constructor(public readonly code:string, message:string, public readonly requestId?:string) { super(message); }
}
type Input={mailboxId:string;subject:string;text:string;idempotencyKey:string};

/** Send only to the owner address selected in settings, from this agent's dedicated inbox. */
export async function sendToOwner(db:Database,dataDir:string,agentId:string,input:Input,authenticated:()=>boolean) {
  if (!authenticated() || !dedicatedInbox(db,agentId,input.mailboxId)) throw new DirectSendError("FORBIDDEN","This mailbox is not your dedicated agent inbox.");
  const existing=async () => {
    const row=db.query(`SELECT r.id,r.state,r.mailbox_id,d.mime_fields_json,d.encrypted_body FROM send_requests r JOIN drafts d ON d.id=r.draft_id WHERE r.agent_id=? AND r.idempotency_key=?`).get(agentId,input.idempotencyKey) as {id:string;state:string;mailbox_id:string;mime_fields_json:string;encrypted_body:string}|null;
    if (!row) return null;
    const fields=JSON.parse(row.mime_fields_json) as {mode?:string;subject?:string};
    if (row.mailbox_id!==input.mailboxId || fields.mode!=="agent_to_owner" || fields.subject!==input.subject || await decryptSecret(dataDir,row.mailbox_id,row.encrypted_body)!==input.text) throw new DirectSendError("IDEMPOTENCY_CONFLICT","This idempotency key was already used for a different message.");
    return {requestId:row.id,state:row.state};
  };
  const previous=await existing(); if (previous) return previous;
  const body=await encryptSecret(dataDir,input.mailboxId,input.text);
  const draft=randomBytes(16).toString("hex"), request=randomBytes(16).toString("hex"), owner=randomBytes(16).toString("hex");
  let destination:string, sender:{name:string;address:string};
  try {
    const prepared=db.transaction(()=>{
      const now=new Date().toISOString();
      if (!authenticated() || !dedicatedInbox(db,agentId,input.mailboxId)) throw new DirectSendError("FORBIDDEN","This mailbox is not your dedicated agent inbox.");
      const settings=db.query("SELECT personal_email,max_sends_per_hour FROM owner_settings WHERE id=1").get() as {personal_email:string|null;max_sends_per_hour:number}|null;
      if (!settings?.personal_email) throw new DirectSendError("PERSONAL_EMAIL_NOT_SET","The owner must configure a personal email address first.");
      const box=db.query("SELECT smtp_enabled,sender_name,COALESCE(sender_email,email) AS sender_email FROM mailboxes WHERE id=?").get(input.mailboxId) as {smtp_enabled:number;sender_name:string;sender_email:string}|null;
      if (!box?.smtp_enabled) throw new DirectSendError("SMTP_NOT_CONFIGURED","SMTP is not configured.");
      const since=new Date(Date.parse(now)-3600000).toISOString();
      const count=db.query("SELECT COUNT(*) AS count FROM send_requests WHERE smtp_started_at>? AND smtp_started_at<=?").get(since,now) as {count:number};
      if (count.count>=settings.max_sends_per_hour) throw new DirectSendError("RATE_LIMITED","Hourly send limit reached. Try again later.");
      const fields={mode:"agent_to_owner",to:settings.personal_email,subject:input.subject};
      db.query("INSERT INTO drafts(id,mailbox_id,agent_id,mime_fields_json,encrypted_body,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(draft,input.mailboxId,agentId,JSON.stringify(fields),body,now,now);
      db.query(`INSERT INTO send_requests(id,mailbox_id,agent_id,draft_id,draft_revision,state,approval_expires_at,smtp_started_at,idempotency_key,created_at,updated_at,sending_owner,sending_lease_expires_at,sending_origin)
        VALUES(?,?,?,?,1,'sending',?,?,?,?,?,?,?,'agent')`).run(request,input.mailboxId,agentId,draft,now,now,input.idempotencyKey,now,now,owner,Date.now()+DELIVERY_LEASE_MS);
      audit(db,{principalType:"agent",principalId:agentId,mailboxId:input.mailboxId,action:"send.owner",targetId:request,outcome:"sending",time:now});
      return {destination:settings.personal_email,sender:{name:box.sender_name,address:box.sender_email}};
    }).immediate();
    destination=prepared.destination; sender=prepared.sender;
  } catch (error) {
    if (error instanceof DirectSendError) throw error;
    const duplicate=await existing(); if (duplicate) return duplicate;
    throw error;
  }
  const stopLease=holdDeliveryLease(db,request,owner);
  try {
    if (!authenticated() || !dedicatedInbox(db,agentId,input.mailboxId)) {
      finishDelivery(db,request,owner,input.mailboxId,"failed");
      throw new DirectSendError("FORBIDDEN","Inbox access was revoked before submission.",request);
    }
    await sendMail(db,dataDir,input.mailboxId,{to:destination,subject:input.subject,text:input.text},sender);
    if (!finishDelivery(db,request,owner,input.mailboxId,"sent")) throw new DirectSendError("UNKNOWN_DELIVERY_STATUS","Delivery could not be confirmed. Do not retry until the owner checks the mailbox.",request);
    return {requestId:request,state:"sent"};
  } catch (error) {
    if (error instanceof DirectSendError) throw error;
    finishDelivery(db,request,owner,input.mailboxId,"delivery_unknown");
    throw new DirectSendError("UNKNOWN_DELIVERY_STATUS","Delivery could not be confirmed. Do not retry until the owner checks the mailbox.",request);
  } finally { stopLease(); }
}
