import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer as createTlsServer } from "node:tls";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const imapPort = Number(process.env.POSTMOTE_TEST_IMAP_PORT);
const smtpPort = Number(process.env.POSTMOTE_TEST_SMTP_PORT);
const recipient = "berk@berkderooij.nl";

test.skipIf(!imapPort || !smtpPort)("approved SMTP delivery and IMAP read over verified TLS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "postmote-mail-integration-"));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate port");
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const binary = process.env.POSTMOTE_TEST_BINARY;
  const child = Bun.spawn(binary ? [binary, "serve"] : [process.execPath, "src/main.ts", "serve"], { env: { ...process.env, POSTMOTE_DATA_DIR: dir, POSTMOTE_PORT: String(port), POSTMOTE_MAX_SENDS_PER_HOUR:"1" }, stdout: "ignore", stderr: "pipe" });
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, options: RequestInit = {}) => {
    const res = await fetch(base + path, options);
    const data = await res.json() as Record<string, any>;
    if (!res.ok) throw new Error(`API ${path}: ${res.status} ${JSON.stringify(data)}`);
    return { data, headers: res.headers };
  };
  try {
    for (let i = 0; ; i++) {
      try { await api("/api/health"); break; } catch { if (i === 100) throw new Error("Daemon did not start"); await Bun.sleep(100); }
    }
    const json = { "content-type": "application/json" };
    await api("/api/setup/initialize", { method: "POST", headers: json, body: JSON.stringify({ password: "integration password" }) });
    const login = await api("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ password: "integration password" }) });
    const headers = { ...json, cookie: login.headers.get("set-cookie")! };
    const settings = { email: recipient, username: recipient, password: "test-password", imapHost: "127.0.0.1", imapPort, imapSecurity: "tls", smtpEnabled: true, smtpHost: "127.0.0.1", smtpPort, smtpSecurity: "tls", smtpUsername: recipient, smtpPassword: "test-password" };
    for (const kind of ["imap", "smtp"]) {
      let ok = false;
      for (let i = 0; i < 10; i++) {
        const tested = await api(`/api/mailboxes/test-${kind}`, { method: "POST", headers, body: JSON.stringify(settings) });
        if (tested.data.ok) { ok = true; break; }
        await Bun.sleep(500);
      }
      expect(ok).toBe(true);
    }
    for (const kind of ["imap", "smtp"]) {
      const change = kind === "imap" ? { imapPort: Number(process.env.POSTMOTE_TEST_IMAP_STARTTLS_PORT), imapSecurity: "starttls" } : { smtpPort: Number(process.env.POSTMOTE_TEST_SMTP_STARTTLS_PORT), smtpSecurity: "starttls" };
      const checked = await api(`/api/mailboxes/test-${kind}`, { method: "POST", headers, body: JSON.stringify({ ...settings, ...change }) });
      // GreenMail does not support STARTTLS: the client must refuse the downgrade.
      expect(checked.data.ok).toBe(false);
      const wrongPassword = kind === "imap" ? { password: "wrong-password" } : { smtpPassword: "wrong-password" };
      const rejected = await api(`/api/mailboxes/test-${kind}`, { method: "POST", headers, body: JSON.stringify({ ...settings, ...wrongPassword }) });
      expect(rejected.data.ok).toBe(false);
    }
    const box = (await api("/api/mailboxes", { method: "POST", headers, body: JSON.stringify(settings) })).data;
    const agent = (await api("/api/agents", { method: "POST", headers, body: JSON.stringify({ label: "Integration" }) })).data;
    await api(`/api/agents/${agent.id}/grants`, { method: "PUT", headers, body: JSON.stringify({ grants: [{ mailboxId: box.id, capabilities: ["mail.read", "mail.search", "mail.draft", "mail.send.request", "mail.attachments", "mail.modify", "mail.delete", "mail.reply", "mail.forward"] }] }) });
    const mcp = async (name: string, args: object, token=agent.token) => {
      const res = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const text = await res.text();
      const data = JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data:"))!.slice(5) : text);
      if (data.result?.isError || data.error) throw new Error(`${name}: ${JSON.stringify(data)}`);
      return data.result.structuredContent;
    };
    const draft = await mcp("mail_draft_create", { mailboxId:box.id, to:[recipient], subject:"Postmote sandbox test", text:"Local integration test." });
    const pending = await mcp("mail_send_request", { draftId:draft.draftId, expectedRevision:draft.revision, idempotencyKey:"integration-test" });
    const changedDraft = await mcp("mail_draft_update", { draftId:draft.draftId, expectedRevision:draft.revision, patch:{text:"Changed after request"} });
    expect(changedDraft.revision).toBe(2);
    const queue = (await api("/api/send-requests", { headers })).data.requests;
    const item = queue.find((request: { id: string }) => request.id === pending.requestId);
    expect(item.to).toEqual([recipient]);
    expect(item.text).toBe("Local integration test.");
    const approvals=await Promise.all([0,1].map(() => fetch(base+`/api/send-requests/${item.id}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:item.reviewHash})})));
    expect(approvals.map(response=>response.status).sort()).toEqual([200,409]);
    expect((await approvals.find(response=>response.status===200)!.json()).state).toBe("sent");
    const secondRequest=await mcp("mail_send_request",{mailboxId:box.id,to:recipient,subject:"Rate limit test",text:"Must not be sent",idempotencyKey:"rate-limit-test"});
    const secondQueue=(await api("/api/send-requests",{headers})).data.requests;
    const secondItem=secondQueue.find((request:{id:string}) => request.id===secondRequest.requestId);
    const limited=await fetch(base+`/api/send-requests/${secondRequest.requestId}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:secondItem.reviewHash})});
    expect(limited.status).toBe(429);
    expect((await mcp("mail_send_status",{requestId:secondRequest.requestId})).state).toBe("pending");
    const activity=(await api("/api/activity",{headers})).data.events;
    expect(activity.map((event:{action:string}) => event.action)).toContain("send.approve");
    expect(activity.map((event:{action:string}) => event.action)).toContain("send.submit");
    expect(JSON.stringify(activity)).not.toContain("Local integration test.");
    await api(`/api/send-requests/${secondRequest.requestId}/reject`,{method:"POST",headers,body:"{}"});
    const status = await mcp("mail_send_status", { requestId: item.id });
    expect(status.state).toBe("sent");
    expect(status.approvedAt).toBeTruthy();
    const { ImapFlow } = await import("imapflow");
    const imap = new ImapFlow({ host: "127.0.0.1", port: imapPort, secure: true, auth: { user: recipient, pass: "test-password" }, tls: { rejectUnauthorized: true }, disableAutoIdle: true, logger: false });
    await imap.connect();
    try {
      await imap.mailboxCreate("PostmoteTests");
      await imap.append("INBOX", `From: ${recipient}\r\nTo: ${recipient}\r\nSubject: Search fixture one\r\nMessage-ID: <sandbox-fixture@example.test>\r\n\r\nFixture body\r\n`);
      await imap.append("INBOX", `From: ${recipient}\r\nTo: ${recipient}\r\nSubject: Search fixture two\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=sample-boundary\r\n\r\n--sample-boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nFixture body =C3=A9\r\n--sample-boundary\r\nContent-Type: text/plain; name=note.txt\r\nContent-Disposition: attachment; filename=note.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--sample-boundary--\r\n`);
    } finally { await imap.logout(); }
    const initialPoll = await mcp("mail_poll", { mailboxId:box.id });
    expect(initialPoll.newCount).toBe(3);
    expect(initialPoll.remaining).toBe(0);
    const repeatedPoll = await mcp("mail_poll", { mailboxId:box.id });
    expect(repeatedPoll.newCount).toBe(0);
    expect(repeatedPoll.updatedCount).toBe(3);
    const initialStatus = await mcp("mail_status", { mailboxId:box.id });
    expect(initialStatus.unreadCount).toBe(3);
    expect(initialStatus.imap.lastPollAt).toBeTruthy();
    const withAttachment=await mcp("mail_search",{mailboxId:box.id,subject:"Search fixture",hasAttachment:true,after:"2000-01-01T00:00:00Z",before:"2999-01-01T00:00:00Z"});
    expect(withAttachment.messages.length).toBe(1);
    expect(withAttachment.messages[0].hasAttachments).toBe(true);
    const withoutAttachment=await mcp("mail_search",{mailboxId:box.id,subject:"Search fixture",hasAttachment:false});
    expect(withoutAttachment.messages.length).toBe(1);
    expect(withoutAttachment.messages[0].hasAttachments).toBe(false);
    const future=await mcp("mail_search",{mailboxId:box.id,subject:"Search fixture",after:"2999-01-01T00:00:00Z"});
    expect(future.messages.length).toBe(0);
    const firstPage = await mcp("mail_search", { mailboxId: box.id, subject: "Search fixture", pageSize: 1 });
    expect(firstPage.messages.length).toBe(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await mcp("mail_search", { mailboxId: box.id, subject: "Search fixture", pageSize: 1, cursor: firstPage.nextCursor });
    expect(secondPage.messages.length).toBe(1);
    expect(secondPage.messages[0].ref.uid).not.toBe(firstPage.messages[0].ref.uid);
    expect(secondPage.nextCursor).toBeNull();
    const reply=await mcp("mail_reply_draft", { message:secondPage.messages[0].ref, replyAll:true, text:"Thanks" });
    expect(reply.preview.to).toEqual([recipient]);
    expect(reply.preview.inReplyTo).toBe("<sandbox-fixture@example.test>");
    const forward=await mcp("mail_forward_draft", { message:secondPage.messages[0].ref, to:[recipient], text:"For review" });
    expect(forward.preview.text).toContain("Fixture body");
    const blockedForward = await fetch(base + "/mcp", { method:"POST", headers:{authorization:`Bearer ${agent.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"mail_forward_draft",arguments:{message:firstPage.messages[0].ref,to:[recipient]}}}) });
    expect(await blockedForward.text()).toContain("ATTACHMENTS_UNSUPPORTED");
    const parsed = await mcp("mail_get", { message: firstPage.messages[0].ref });
    expect(parsed.message.text).toContain("Fixture body é");
    expect(parsed.message.attachments).toMatchObject([{ name: "note.txt", mimeType: "text/plain", sizeBytes: 5 }]);
    expect(parsed.untrusted).toBe(true);
    const attachment = await mcp("mail_attachment_info", { message:firstPage.messages[0].ref, attachmentId:"0" });
    expect(attachment).toMatchObject({ filename:"note.txt", sizeBytes:5, mimeType:"text/plain" });
    const chunk = await mcp("mail_attachment_read", { message:firstPage.messages[0].ref, attachmentId:"0", offset:1, length:2 });
    expect(Buffer.from(chunk.dataBase64, "base64").toString()).toBe("el");
    expect(chunk.truncated).toBe(true);
    const folders = await mcp("mail_folders", { mailboxId: box.id });
    expect(folders.folders.some((folder: { path: string }) => folder.path === "INBOX")).toBe(true);
    const listFirst=await mcp("mail_list",{mailboxId:box.id,folder:"INBOX",pageSize:1,unreadOnly:true});
    expect(listFirst.messages.length).toBe(1);
    expect(listFirst.nextCursor).toBeTruthy();
    const listSecond=await mcp("mail_list",{mailboxId:box.id,folder:"INBOX",pageSize:1,unreadOnly:true,cursor:listFirst.nextCursor});
    expect(listSecond.messages[0].ref.uid).not.toBe(listFirst.messages[0].ref.uid);
    const list = await mcp("mail_list", { mailboxId: box.id, folder: "INBOX" });
    expect(list.messages.length).toBe(3);
    const sentMessage = list.messages.find((item: { envelope?: { subject?: string } }) => item.envelope?.subject === "Postmote sandbox test");
    expect(sentMessage).toBeTruthy();
    const resourceUri=`postmote://mailbox/${encodeURIComponent(box.id)}/message/${encodeURIComponent(sentMessage.ref.folder)}/${sentMessage.ref.uidValidity}/${sentMessage.ref.uid}`;
    const resourceResponse=await fetch(base+"/mcp",{method:"POST",headers:{authorization:`Bearer ${agent.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:7,method:"resources/read",params:{uri:resourceUri}})});
    const resourceText=await resourceResponse.text();
    const resourceData=JSON.parse(resourceText.startsWith("event:") ? resourceText.split("\n").find(line=>line.startsWith("data:"))!.slice(5) : resourceText);
    expect(JSON.parse(resourceData.result.contents[0].text).text).toContain("Local integration test.");
    const message = await mcp("mail_read", sentMessage.ref);
    expect(message.source).toContain("Local integration test.");
    expect(message.untrusted).toBe(true);
    const modify = new ImapFlow({ host: "127.0.0.1", port: imapPort, secure: true, auth: { user: recipient, pass: "test-password" }, tls: { rejectUnauthorized: true }, disableAutoIdle: true, logger: false });
    await modify.connect();
    const safeMove = modify.capabilities.has("MOVE") || modify.capabilities.has("UIDPLUS");
    try {
      const lock = await modify.getMailboxLock("INBOX");
      try {
        const flags=await mcp("mail_flags", { message:firstPage.messages[0].ref, operation:"add", flags:["\\Seen"] });
        expect(flags.newFlags).toContain("\\Seen");
        await modify.messageDelete(String(secondPage.messages[0].ref.uid), { uid:true });
      } finally { lock.release(); }
    } finally { await modify.logout(); }
    const reconciled = await mcp("mail_poll", { mailboxId:box.id });
    expect(reconciled.deletedCount).toBe(1);
    const updatedStatus = await mcp("mail_status", { mailboxId:box.id });
    expect(updatedStatus.unreadCount).toBe(1);
    const inspect = new Database(join(dir, "postmote.db"));
    try {
      const before = inspect.query("SELECT uidvalidity FROM folder_state WHERE mailbox_id=? AND folder_path='INBOX'").get(box.id) as {uidvalidity:number};
      inspect.query("UPDATE folder_state SET uidvalidity=?,highest_uid=0 WHERE mailbox_id=? AND folder_path='INBOX'").run(before.uidvalidity === 1 ? 2 : 1,box.id);
      const rebuilt = await mcp("mail_poll", { mailboxId:box.id });
      expect(rebuilt.newCount).toBe(2);
      expect(inspect.query("SELECT COUNT(*) AS count FROM message_index WHERE mailbox_id=?").get(box.id)).toEqual({ count:2 });
      inspect.query("INSERT INTO mailbox_poll_locks(mailbox_id,owner,expires_at) VALUES(?,?,?)").run(box.id,"other-process",Date.now()+60000);
      const lockedResponse = await fetch(base + "/mcp", { method:"POST", headers:{ authorization:`Bearer ${agent.token}`, "content-type":"application/json", accept:"application/json, text/event-stream" }, body:JSON.stringify({ jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"mail_poll",arguments:{mailboxId:box.id}} }) });
      expect(await lockedResponse.text()).toContain("POLL_IN_PROGRESS");
      inspect.query("DELETE FROM mailbox_poll_locks WHERE mailbox_id=?").run(box.id);
    } finally { inspect.close(); }
    const bulk = new ImapFlow({ host:"127.0.0.1",port:imapPort,secure:true,auth:{user:recipient,pass:"test-password"},tls:{rejectUnauthorized:true},disableAutoIdle:true,logger:false });
    await bulk.connect();
    try { for (let i=0;i<201;i++) await bulk.append("INBOX", `From: ${recipient}\r\nTo: ${recipient}\r\nSubject: Batch fixture\r\n\r\nBody\r\n`); } finally { await bulk.logout(); }
    const batch = await mcp("mail_poll", { mailboxId:box.id });
    expect(batch.newCount).toBe(198);
    expect(batch.remaining).toBe(3);
    expect((await mcp("mail_status", { mailboxId:box.id })).unreadCount).toBeNull();
    const lastBatch = await mcp("mail_poll", { mailboxId:box.id });
    expect(lastBatch.newCount).toBe(3);
    expect(lastBatch.remaining).toBe(0);
    expect((await mcp("mail_status", { mailboxId:box.id })).unreadCount).toBe(202);
    const largeClient=new ImapFlow({ host:"127.0.0.1",port:imapPort,secure:true,auth:{user:recipient,pass:"test-password"},tls:{rejectUnauthorized:true},disableAutoIdle:true,logger:false });
    await largeClient.connect();
    try {
      const encoded=Buffer.alloc(1100000,0x5a).toString("base64").match(/.{1,76}/g)!.join("\r\n");
      await largeClient.append("INBOX", `From: ${recipient}\r\nTo: ${recipient}\r\nSubject: Large fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=large-boundary\r\n\r\n--large-boundary\r\nContent-Type: text/plain\r\n\r\nLarge attachment\r\n--large-boundary\r\nContent-Type: application/octet-stream; name=large.bin\r\nContent-Disposition: attachment; filename=large.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n--large-boundary--\r\n`);
    } finally { await largeClient.logout(); }
    const largeSearch=await mcp("mail_search",{mailboxId:box.id,subject:"Large fixture"});
    expect(largeSearch.messages.length).toBe(1);
    const largeRef=largeSearch.messages[0].ref;
    const largeMessage=await mcp("mail_get",{message:largeRef});
    expect(largeMessage.message.attachments[0].sizeBytes).toBe(1100000);
    const largeChunk=await mcp("mail_attachment_read",{message:largeRef,attachmentId:"0",offset:1048576,length:128});
    expect(Buffer.from(largeChunk.dataBase64,"base64")).toEqual(Buffer.alloc(128,0x5a));
    const rawLarge=await fetch(base+"/mcp",{method:"POST",headers:{authorization:`Bearer ${agent.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"mail_read",arguments:largeRef}})});
    expect(await rawLarge.text()).toContain("MESSAGE_TOO_LARGE");
    if (safeMove) {
      const moved=await mcp("mail_move",{message:firstPage.messages[0].ref,destinationFolder:"PostmoteTests"});
      expect(moved.moved).toBe(true);
      const reconcileAfterMove=await mcp("mail_poll",{mailboxId:box.id});
      expect(reconcileAfterMove.remaining).toBe(3);
      const finishMove=await mcp("mail_poll",{mailboxId:box.id});
      expect(finishMove.deletedCount).toBe(1);
    }


    await api("/api/settings",{method:"PUT",headers,body:JSON.stringify({personalEmail:recipient})});
    await api(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:box.id})});
    const quotaDb=new Database(join(dir,"postmote.db"));
    try { quotaDb.query("UPDATE send_requests SET smtp_started_at=? WHERE id=?").run(new Date(Date.now()-7200000).toISOString(),item.id); } finally { quotaDb.close(); }
    const directRace=await Promise.all([0,1].map(async number=>{
      const args={mailboxId:box.id,subject:"Direct sandbox test",text:"Local direct test",idempotencyKey:`direct-test-${number}`};
      const response=await fetch(base+"/mcp",{method:"POST",headers:{authorization:`Bearer ${agent.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:number,method:"tools/call",params:{name:"mail_send_owner",arguments:args}})});
      const text=await response.text(), parsed=JSON.parse(text.startsWith("event:")?text.split("\n").find(line=>line.startsWith("data:"))!.slice(5):text);
      return {key:args.idempotencyKey,result:parsed.result};
    }));
    expect(directRace.filter(item=>!item.result.isError)).toHaveLength(1);
    expect(directRace.filter(item=>item.result.isError)).toHaveLength(1);
    expect(JSON.stringify(directRace.find(item=>item.result.isError))).toContain("RATE_LIMITED");
    const winner=directRace.find(item=>!item.result.isError)!;
    const direct=winner.result.structuredContent;
    expect(direct.state).toBe("sent");
    const directReplay=await mcp("mail_send_owner",{mailboxId:box.id,subject:"Direct sandbox test",text:"Local direct test",idempotencyKey:winner.key});
    expect(directReplay.requestId).toBe(direct.requestId);
    expect((await mcp("mail_send_status",{requestId:direct.requestId})).state).toBe("sent");
    const directSearch=await mcp("mail_search",{mailboxId:box.id,subject:"Direct sandbox test"});
    expect(directSearch.messages.length).toBe(1);
    const stdioBinary=process.env.POSTMOTE_TEST_BINARY || process.execPath;
    const stdioArgs=process.env.POSTMOTE_TEST_BINARY ? ["mcp","stdio"] : [join(import.meta.dir,"../src/main.ts"),"mcp","stdio"];
    const stdio=spawn(stdioBinary,stdioArgs,{env:{...process.env,POSTMOTE_DATA_DIR:dir,POSTMOTE_AGENT_TOKEN:agent.token,POSTMOTE_MAX_SENDS_PER_HOUR:"1000"},stdio:["pipe","pipe","pipe"]});
    const lines=createInterface({input:stdio.stdout})[Symbol.asyncIterator]();
    const stdioCall=async(message:object)=>{stdio.stdin.write(JSON.stringify(message)+"\n");const line=await Promise.race([lines.next(),Bun.sleep(10000).then(()=>{throw new Error("Stdio response timed out")})]);if(line.done)throw new Error("Stdio exited");return JSON.parse(line.value);};
    let stdioRequestId="";
    try {
      await stdioCall({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"integration",version:"1"}}});
      stdio.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
      const limited=await stdioCall({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"mail_send_owner",arguments:{mailboxId:box.id,subject:"Stdio sandbox test",text:"Local stdio test",idempotencyKey:"stdio-direct"}}});
      expect(limited.result.isError).toBe(true);
      expect(JSON.stringify(limited)).toContain("RATE_LIMITED");
      const quota=new Database(join(dir,"postmote.db"));
      try { quota.query("UPDATE send_requests SET smtp_started_at=? WHERE id=?").run(new Date(Date.now()-7200000).toISOString(),direct.requestId); } finally { quota.close(); }
      const sent=await stdioCall({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"mail_send_owner",arguments:{mailboxId:box.id,subject:"Stdio sandbox test",text:"Local stdio test",idempotencyKey:"stdio-direct"}}});
      expect(sent.result.structuredContent.state).toBe("sent");
      stdioRequestId=sent.result.structuredContent.requestId;
    } finally { stdio.stdin.end(); await new Promise<void>(resolve=>{if(stdio.exitCode!==null)resolve();else{stdio.once("exit",()=>resolve());setTimeout(()=>stdio.kill(),1000).unref()}}); }
    expect((await mcp("mail_search",{mailboxId:box.id,subject:"Stdio sandbox test"})).messages.length).toBe(1);
    const resetQuota=new Database(join(dir,"postmote.db"));
    try { resetQuota.query("UPDATE send_requests SET smtp_started_at=? WHERE id IN (?,?)").run(new Date(Date.now()-7200000).toISOString(),direct.requestId,stdioRequestId); } finally { resetQuota.close(); }
    const selfAgent=(await api("/api/agents",{method:"POST",headers,body:JSON.stringify({label:"Self-configured",allowInboxSetup:true})})).data;
    const configured=await mcp("agent_inbox_setup",{email:"agent@example.test",username:"agent@example.test",password:"test-password",imapHost:"127.0.0.1",imapPort,imapSecurity:"tls",smtpEnabled:true,smtpHost:"127.0.0.1",smtpPort,smtpSecurity:"tls",smtpUsername:"agent@example.test",smtpPassword:"test-password"},selfAgent.token);
    expect((await mcp("agent_inbox",{},selfAgent.token)).personalEmail).toBe(recipient);
    const incoming=new ImapFlow({host:"127.0.0.1",port:imapPort,secure:true,auth:{user:"agent@example.test",pass:"test-password"},tls:{rejectUnauthorized:true},disableAutoIdle:true,logger:false});
    await incoming.connect();
    const supportsUidExpunge=incoming.capabilities.has("UIDPLUS");
    try {await incoming.append("INBOX",`From: ${recipient}\r\nTo: agent@example.test\r\nSubject: Owner message\r\n\r\nHello agent\r\n`);} finally {await incoming.logout();}
    expect((await mcp("mail_poll",{mailboxId:configured.mailboxId},selfAgent.token)).newCount).toBe(1);
    const agentList=await mcp("mail_list",{mailboxId:configured.mailboxId},selfAgent.token);
    expect((await mcp("mail_get",{message:agentList.messages[0].ref},selfAgent.token)).message.text).toContain("Hello agent");
    const expungeResponse=await fetch(base+"/mcp",{method:"POST",headers:{authorization:`Bearer ${selfAgent.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:14,method:"tools/call",params:{name:"mail_expunge",arguments:{message:agentList.messages[0].ref}}})});
    const expungeText=await expungeResponse.text();
    if (supportsUidExpunge) {
      expect(expungeText).toContain('"deleted":true');
      expect((await mcp("mail_search",{mailboxId:configured.mailboxId,subject:"Owner message"},selfAgent.token)).messages).toHaveLength(0);
    } else expect(expungeText).toContain("MOVE_UNAVAILABLE");
    const selfDirect=await mcp("mail_send_owner",{mailboxId:configured.mailboxId,subject:"Agent reply sandbox",text:"Hello owner",idempotencyKey:"agent-reply"},selfAgent.token);
    expect(selfDirect.state).toBe("sent");
    expect((await mcp("mail_search",{mailboxId:box.id,subject:"Agent reply sandbox"})).messages.length).toBe(1);
    const selfQuota=new Database(join(dir,"postmote.db"));
    try {selfQuota.query("UPDATE send_requests SET smtp_started_at=? WHERE id=?").run(new Date(Date.now()-7200000).toISOString(),selfDirect.requestId);} finally {selfQuota.close();}
    let dataTransactions=0, invalidRecipient=false;
    const fakeSmtp=createTlsServer({key:await readFile(process.env.POSTMOTE_TEST_PRIVATE_KEY!),cert:await readFile(process.env.POSTMOTE_TEST_CERT!)},socket => {
      let buffer="", dataMode=false;
      socket.write("220 localhost ESMTP test\r\n");
      socket.on("data",chunk => {
        buffer+=chunk.toString("utf8");
        for (;;) {
          const end=buffer.indexOf("\r\n"); if (end<0) break;
          const line=buffer.slice(0,end); buffer=buffer.slice(end+2);
          if (dataMode) { if (line===".") { dataTransactions++; socket.destroy(); return; } continue; }
          if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (/^AUTH PLAIN /i.test(line)) socket.write("235 2.7.0 authenticated\r\n");
          else if (/^MAIL FROM:/i.test(line)) socket.write("250 2.1.0 ok\r\n");
          else if (/^RCPT TO:/i.test(line)) { if (line.toLowerCase()!==`rcpt to:<${recipient}>`) { invalidRecipient=true; socket.write("550 unexpected recipient\r\n"); } else socket.write("250 2.1.5 ok\r\n"); }
          else if (/^DATA$/i.test(line)) { dataMode=true; socket.write("354 end with dot\r\n"); }
          else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>(resolve => fakeSmtp.listen(0,"127.0.0.1",resolve));
    try {
      const addr=fakeSmtp.address(); if (!addr || typeof addr==="string") throw new Error("Cannot allocate fake SMTP port");
      const ambiguousBox=(await api("/api/mailboxes",{method:"POST",headers,body:JSON.stringify({...settings,imapHost:"localhost",smtpPort:addr.port})})).data;
      await api(`/api/agents/${agent.id}/grants`,{method:"PUT",headers,body:JSON.stringify({grants:[{mailboxId:box.id,capabilities:["mail.read","mail.search","mail.draft","mail.send.request","mail.attachments","mail.modify","mail.delete","mail.reply","mail.forward"]},{mailboxId:ambiguousBox.id,capabilities:["mail.send.request"]}]})});
      const uncertain=await mcp("mail_send_request",{mailboxId:ambiguousBox.id,to:recipient,subject:"Ambiguous sandbox test",text:"Local test",idempotencyKey:"ambiguous-test"});
      const requests=(await api("/api/send-requests",{headers})).data.requests;
      const uncertainItem=requests.find((request:{id:string}) => request.id===uncertain.requestId);
      const submit=await fetch(base+`/api/send-requests/${uncertain.requestId}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:uncertainItem.reviewHash})});
      expect(submit.status).toBe(502);
      expect((await mcp("mail_send_status",{requestId:uncertain.requestId})).state).toBe("delivery_unknown");
      const retry=await fetch(base+`/api/send-requests/${uncertain.requestId}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:uncertainItem.reviewHash})});
      expect(retry.status).toBe(409);
      expect(dataTransactions).toBe(1);
      expect(invalidRecipient).toBe(false);
    } finally { await new Promise<void>(resolve => fakeSmtp.close(()=>resolve())); }
  } finally {
    child.kill();
    await child.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 90000);
