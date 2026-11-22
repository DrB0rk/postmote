import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { decryptSecret, ensureMasterKey } from "../src/vault.ts";
import { createAgentMcpHandler } from "../src/mcp.ts";

const recipient = "berk@berkderooij.nl";
test("draft revisions and immutable send snapshots respect agent grants", async () => {
  const dir=await mkdtemp(join(tmpdir(),"postmote-draft-"));
  await ensureMasterKey(dir);
  const db=await openDatabase(dir);
  const now=new Date().toISOString();
  db.query("INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at,smtp_enabled) VALUES('box','Box',?,'localhost',993,'tls','owner','cipher',120,?,?,1)").run(recipient,now,now);
  for (const id of ["one","two"]) db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?)").run(id,id,`hash-${id}`,id,now);
  for (const capability of ["mail.draft","mail.send.request"]) db.query("INSERT INTO agent_mailbox_grants(agent_id,mailbox_id,capability,created_at) VALUES('one','box',?,?)").run(capability,now);
  const handler=createAgentMcpHandler(db,dir);
  const call=async (agent:string,name:string,args:object) => {
    const response=await handler.fetch(new Request("http://127.0.0.1/mcp", { method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}) }),{authInfo:{token:"test",clientId:agent,scopes:[]}});
    const text=await response.text(); const parsed=JSON.parse(text.startsWith("event:") ? text.split("\n").find(line=>line.startsWith("data:"))!.slice(5) : text);
    return parsed.result;
  };
  try {
    const denied=await call("two","mail_draft_create",{mailboxId:"box"});
    expect(denied.isError).toBe(true);
    const created=(await call("one","mail_draft_create",{mailboxId:"box"})).structuredContent;
    expect(created.revision).toBe(1);
    expect((await call("one","mail_draft_get",{draftId:created.draftId})).structuredContent.compose.text).toBe("");
    expect((await call("two","mail_draft_get",{draftId:created.draftId})).isError).toBe(true);
    const draftInput={draftId:created.draftId,expectedRevision:1,patch:{to:[recipient],subject:"Draft subject",text:"Original body"}};
    const updated=(await call("one","mail_draft_update",draftInput)).structuredContent;
    expect(updated.revision).toBe(2);
    expect((await call("one","mail_draft_update",draftInput)).isError).toBe(true);
    const concurrent=await Promise.all([
      call("one","mail_draft_update",{draftId:created.draftId,expectedRevision:2,patch:{subject:"Concurrent A"}}),
      call("one","mail_draft_update",{draftId:created.draftId,expectedRevision:2,patch:{subject:"Concurrent B"}}),
    ]);
    expect(concurrent.filter(result => !result.isError)).toHaveLength(1);
    expect(concurrent.filter(result => result.isError)).toHaveLength(1);
    const finalEdit=await call("one","mail_draft_update",{draftId:created.draftId,expectedRevision:3,patch:{subject:"Draft subject"}});
    expect(finalEdit.structuredContent.revision).toBe(4);
    const queued=(await call("one","mail_send_request",{draftId:created.draftId,expectedRevision:4,idempotencyKey:"draft-key"})).structuredContent;
    expect(queued.state).toBe("pending");
    const edited=await call("one","mail_draft_update",{draftId:created.draftId,expectedRevision:4,patch:{text:"Changed body"}});
    expect(edited.structuredContent.revision).toBe(5);
    const row=db.query("SELECT d.id,d.mime_fields_json,d.encrypted_body FROM send_requests r JOIN drafts d ON d.id=r.draft_id WHERE r.id=?").get(queued.requestId) as {id:string;mime_fields_json:string;encrypted_body:string};
    expect(row.id).not.toBe(created.draftId);
    expect(JSON.parse(row.mime_fields_json).to).toEqual([recipient]);
    expect(await decryptSecret(dir,"box",row.encrypted_body)).toBe("Original body");
    const replay=await call("one","mail_send_request",{draftId:created.draftId,expectedRevision:4,idempotencyKey:"draft-key"});
    expect(replay.structuredContent.requestId).toBe(queued.requestId);
    expect((await call("one","mail_draft_delete",{draftId:row.id})).isError).toBe(true);
    expect((await call("one","mail_draft_delete",{draftId:created.draftId})).structuredContent.deleted).toBe(true);
    expect((await call("one","mail_send_request",{draftId:created.draftId,expectedRevision:4,idempotencyKey:"draft-key"})).structuredContent.requestId).toBe(queued.requestId);
    expect((await call("two","mail_send_status",{requestId:queued.requestId})).isError).toBe(true);
  } finally { await handler.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});
