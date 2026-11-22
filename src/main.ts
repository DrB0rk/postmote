import packageInfo from "../package.json";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteError } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { createBackup } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { imapConnectionInputSchema, mailboxInputSchema, smtpConnectionInputSchema } from "./mailbox.ts";
import { decryptSecret, encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "./vault.ts";
import { authenticateAgentToken, createAgentMcpHandler, createAgentMcpServer } from "./mcp.ts";
import { testImapConnection, testSmtpConnection } from "./mail/connections.ts";
import { readThunderbirdCredentials, ThunderbirdCredentialError } from "./thunderbird-credentials.ts";
import { createMailbox, updateMailbox, deleteMailbox, mailboxPatchSchema, MailboxNotFound, MailboxInvalid, MailboxConflict, MailboxSending, MailboxAssignedInbox } from "./mail/accounts.ts";
import { discoverThunderbirdProfiles, readThunderbirdProfile } from "./thunderbird.ts";
import { sendMail } from "./mail/operations.ts";
import { audit } from "./mail/audit.ts";
import { startPollScheduler } from "./mail/poller.ts";
import { recoverInterruptedDeliveries, holdDeliveryLease, finishDelivery, DELIVERY_LEASE_MS } from "./mail/outbox.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";

const VERSION = packageInfo.version;
const config = loadConfig();
const command = process.argv.slice(2);

if (command[0] === "--version" || command[0] === "-V") {
  console.log(`postmote ${VERSION}`);
} else if (command[0] === "init") {
  await ensureMasterKey(config.dataDir);
  const db = await openDatabase(config.dataDir);
  db.close();
  console.log(`Initialized Postmote data directory at ${config.dataDir}`);
  console.log("Open the dashboard with `postmote serve` to set the owner password.");
} else if (command[0] === "backup") {
  if (!command[1] || command.length !== 2) {
    console.error("Usage: postmote backup /absolute/new-directory");
    process.exitCode=2;
  } else {
    try { const destination=await createBackup(config.dataDir,command[1]); console.log(`Backup created at ${destination}`); }
    catch (error) { console.error(`Backup failed: ${error instanceof Error && error.message.includes("absolute path") ? error.message : "destination already exists or source/backup could not be accessed."}`); process.exitCode=1; }
  }
} else if (command[0] === "doctor") {
  const db = await openDatabase(config.dataDir);
  const initialized = db.query("SELECT 1 FROM owner_credentials WHERE id=1").get() !== null;
  db.close();
  console.log(JSON.stringify({ version: VERSION, bind: config.bind, port: config.port, dataDir: config.dataDir, initialized, masterKey: Bun.file(config.masterKeyFile).size > 0 ? "present" : "missing" }, null, 2));
} else if (command[0] === "config" && command[1] === "show") {
  console.log(JSON.stringify({ bind: config.bind, port: config.port, dataDir: config.dataDir, masterKeyFile:config.masterKeyFile, pollSeconds: config.pollSeconds, maxSendsPerHour:config.maxSendsPerHour, logLevel: config.logLevel }, null, 2));
} else if (command[0] === "mcp" && command[1] === "stdio") {
  const token = process.env.POSTMOTE_AGENT_TOKEN;
  if (!token) {
    console.error("Set POSTMOTE_AGENT_TOKEN to an agent token created in the Postmote dashboard.");
    process.exitCode = 2;
  } else {
    try {
      await Promise.all([access(join(config.dataDir, "postmote.db")), access(config.masterKeyFile)]);
      const db = await openDatabase(config.dataDir);
      if (!authenticateAgentToken(db, token)) {
        db.close();
        console.error("Invalid or revoked Postmote agent token.");
        process.exitCode = 2;
      } else {
        const handle = serveStdio(() => createAgentMcpServer(db, config.dataDir, () => authenticateAgentToken(db, token)?.clientId), {
          onerror: () => console.error("MCP stdio transport error."),
        });
        let closing = false;
        const shutdown = async () => { if (closing) return; closing = true; await handle.close(); db.close(); };
        process.once("SIGINT", () => { void shutdown(); });
        process.once("SIGTERM", () => { void shutdown(); });
      }
    } catch {
      console.error("Cannot open Postmote data. Run postmote init and configure an agent in the dashboard first.");
      process.exitCode = 2;
    }
  }
} else if (command[0] === "serve") {
  await ensureMasterKey(config.dataDir);
  const releaseLock = await acquireDaemonLock(config.dataDir);
  const db = await openDatabase(config.dataDir);
  db.query("UPDATE owner_settings SET max_sends_per_hour=? WHERE id=1").run(config.maxSendsPerHour);
  recoverInterruptedDeliveries(db,new Date().toISOString(),true);
  const recoveryTimer=setInterval(()=>{try{recoverInterruptedDeliveries(db)}catch{/* A later pass retries recovery. */}},30000);
  recoveryTimer.unref();
  const pollScheduler = startPollScheduler(db, config.dataDir);
  const app = new Hono();
  const mcpHandler = createAgentMcpHandler(db, config.dataDir);
  const rateCounters = new Map<string, { count: number; resetAt: number }>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const host = c.req.header("host") ?? "";
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return c.text("Invalid host", 400);
    const origin = c.req.header("origin");
    if (origin && origin !== `http://127.0.0.1:${config.port}` && origin !== `http://localhost:${config.port}`) return c.text("Invalid origin", 403);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 262144, onError: c => c.json({ error: "Request body too large." }, 413) }));
  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));
  app.post("/api/setup/initialize", async (c) => {
    if (!allowRate(rateCounters, "setup", 5, 10 * 60_000)) return c.json({ error: "Too many setup attempts. Try again later." }, 429);
    if (db.query("SELECT 1 FROM owner_credentials WHERE id=1").get()) return c.json({ error: "Already initialized" }, 409);
    const body = await c.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!body.password) return c.json({ error: "Password is required" }, 400);
    try {
      const hash = await hashOwnerPassword(body.password);
      db.query("INSERT INTO owner_credentials(id,password_hash,created_at) VALUES(1,?,?)").run(hash, new Date().toISOString());
      return c.json({ initialized: true }, 201);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid password" }, 400); }
  });
  app.post("/api/auth/login", async (c) => {
    if (!allowRate(rateCounters, "login", 10, 10 * 60_000)) return c.json({ error: "Too many login attempts. Try again later." }, 429);
    const body = await c.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    const row = db.query("SELECT password_hash FROM owner_credentials WHERE id=1").get() as { password_hash: string } | null;
    if (!row || !body.password || !(await verifyOwnerPassword(body.password, row.password_hash))) return c.json({ error: "Invalid credentials" }, 401);
    rateCounters.delete("login");
    const session = randomBytes(32).toString("base64url");
    const idHash = createHash("sha256").update(session).digest("hex");
    db.query("INSERT INTO owner_sessions(id_hash,issued_at,expires_at) VALUES(?,?,?)").run(idHash, new Date().toISOString(), new Date(Date.now() + 12 * 3600_000).toISOString());
    c.header("Set-Cookie", `postmote_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return c.json({ authenticated: true });
  });
  app.get("/api/auth/me", (c) => c.json({ initialized: db.query("SELECT 1 FROM owner_credentials WHERE id=1").get() !== null, authenticated: isOwnerAuthorized(c.req.header("cookie"), db) }));
  app.post("/api/auth/logout", (c) => {
    const session = /(?:^|;\s*)postmote_session=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
    if (session) db.query("UPDATE owner_sessions SET revoked_at=? WHERE id_hash=?").run(new Date().toISOString(), createHash("sha256").update(session).digest("hex"));
    c.header("Set-Cookie", "postmote_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return c.json({ authenticated: false });
  });
  app.post("/api/mailboxes", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const input = await c.req.json().catch(() => null);
    const parsed = mailboxInputSchema.safeParse(input);
    if (!parsed.success) return c.json({ error: "Invalid mailbox", fields: parsed.error.flatten().fieldErrors }, 400);
    try { return c.json(await createMailbox(db,config.dataDir,parsed.data),201); }
    catch (error) {
      if (error instanceof SQLiteError && [1555,2067].includes(error.errno)) return c.json({error:"Mailbox already exists"},409);
      const requestId=randomBytes(8).toString("hex");
      console.error(`Mailbox save failed (${requestId}): ${error instanceof SQLiteError ? `SQLite ${error.errno}` : error instanceof Error ? error.name : "unknown error"}`);
      return c.json({error:"Mailbox could not be saved",requestId},500);
    }
  });
  app.post("/api/mailboxes/test-imap", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    if (!allowRate(rateCounters, "test-imap", 10, 60_000)) return c.json({ error: "Too many connection tests. Try again later." }, 429);
    const parsed = imapConnectionInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid mailbox settings", fields: parsed.error.flatten().fieldErrors }, 400);
    const values = parsed.data;
    return c.json(await testImapConnection({ host: values.imapHost, port: values.imapPort, security: values.imapSecurity, username: values.username, password: values.password }));
  });
  app.post("/api/mailboxes/test-smtp", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    if (!allowRate(rateCounters, "test-smtp", 10, 60_000)) return c.json({ error: "Too many connection tests. Try again later." }, 429);
    const parsed = smtpConnectionInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid mailbox settings", fields: parsed.error.flatten().fieldErrors }, 400);
    const values = parsed.data;
    return c.json(await testSmtpConnection({ host: values.smtpHost, port: values.smtpPort, security: values.smtpSecurity, username: values.smtpUsername, password: values.smtpPassword }));
  });
  app.get("/api/mailboxes", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ mailboxes: db.query("SELECT id,label,email,imap_host AS imapHost,imap_port AS imapPort,imap_security AS imapSecurity,username,sender_name AS senderName,sender_email AS senderEmail,mailbox_root AS mailboxRoot,smtp_username AS smtpUsername,smtp_host AS smtpHost,smtp_port AS smtpPort,smtp_security AS smtpSecurity,smtp_enabled AS smtpEnabled,poll_seconds AS pollSeconds,status FROM mailboxes ORDER BY label").all() });
  });
  app.patch("/api/mailboxes/:id",async c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const parsed=mailboxPatchSchema.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"Invalid mailbox settings",fields:parsed.error.flatten().fieldErrors},400);
    try { return c.json(await updateMailbox(db,config.dataDir,c.req.param("id"),parsed.data)); }
    catch (error) {
      if (error instanceof MailboxNotFound) return c.json({error:"Mailbox not found."},404);
      if (error instanceof MailboxInvalid) return c.json({error:"Invalid mailbox settings",fields:error.fields},400);
      if (error instanceof MailboxConflict) return c.json({error:"Mailbox changed. Reload before saving."},409);
      if (error instanceof MailboxSending) return c.json({error:"Cannot change a mailbox while a message is being submitted."},409);
      if (error instanceof MailboxAssignedInbox) return c.json({error:"Unassign this agent inbox before disabling SMTP."},409);
      if (error instanceof SQLiteError && [1555,2067].includes(error.errno)) return c.json({error:"Mailbox already exists."},409);
      return c.json({error:"Mailbox could not be updated."},500);
    }
  });
  app.delete("/api/mailboxes/:id",c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    try { return c.json(deleteMailbox(db,c.req.param("id"))); }
    catch (error) {
      if (error instanceof MailboxNotFound) return c.json({error:"Mailbox not found."},404);
      if (error instanceof MailboxSending) return c.json({error:"Cannot remove a mailbox while a message is being submitted."},409);
      return c.json({error:"Mailbox could not be removed."},500);
    }
  });
  app.get("/api/thunderbird/profiles", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    try { const profiles = await discoverThunderbirdProfiles(); return c.json({ profiles: await Promise.all(profiles.map(async (profile, index) => ({ index, name: profile.name, accounts: await readThunderbirdProfile(profile.path).catch(() => []) }))) }); } catch { return c.json({ error: "Thunderbird profiles could not be found." }, 404); }
  });
  app.post("/api/thunderbird/import", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    if (!allowRate(rateCounters,"thunderbird-import",5,60000)) return c.json({error:"Too many import attempts. Try again later."},429);
    const input=z.object({profileIndex:z.number().int().min(0).max(1000),accountIndex:z.number().int().min(0).max(1000),email:z.string().email().max(254),primaryPassword:z.string().max(1024).refine(value => !value.includes("\0")).default("")}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!input.success) return c.json({error:"Invalid import selection."},400);
    try {
      const profiles=await discoverThunderbirdProfiles(), profile=profiles[input.data.profileIndex];
      if (!profile) return c.json({error:"Profile is no longer available. Refresh the list."},404);
      const accounts=await readThunderbirdProfile(profile.path), account=accounts[input.data.accountIndex];
      if (!account || account.email!==input.data.email) return c.json({error:"Account selection changed. Refresh the list."},409);
      const candidate=mailboxInputSchema.safeParse({label:account.label,email:account.email,senderName:account.senderName,imapHost:account.imapHost,imapPort:account.imapPort,imapSecurity:account.imapSecurity,username:account.username,password:"placeholder",smtpEnabled:true,smtpHost:account.smtpHost,smtpPort:account.smtpPort,smtpSecurity:account.smtpSecurity,smtpUsername:account.smtpUsername,smtpPassword:"placeholder"});
      if (!candidate.success) return c.json({error:"Account settings are incomplete or do not use supported TLS."},400);
      if (db.query("SELECT 1 FROM mailboxes WHERE email=? AND imap_host=?").get(candidate.data.email,candidate.data.imapHost)) return c.json({error:"Mailbox already exists."},409);
      const passwords=await readThunderbirdCredentials(profile.path,account,input.data.primaryPassword);
      if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Session expired."},401);
      const values=mailboxInputSchema.safeParse({...candidate.data,password:passwords.imapPassword,smtpPassword:passwords.smtpPassword});
      if (!values.success) return c.json({error:"Saved credentials do not meet the mailbox requirements."},400);
      const created=await createMailbox(db,config.dataDir,values.data,"mailbox.import");
      return c.json(created,201);
    } catch (error) {
      if (error instanceof SQLiteError && [1555,2067].includes(error.errno)) return c.json({error:"Mailbox already exists."},409);
      if (error instanceof ThunderbirdCredentialError) {
        const messages={locked:"Thunderbird primary password was rejected.",missing:"Saved IMAP or SMTP credentials were not found.",ambiguous:"Multiple saved passwords match this account; import the settings and enter passwords manually.",unsupported:"This account or Thunderbird credential store is not supported for password import.",invalid:"Thunderbird saved credentials could not be read."};
        return c.json({error:messages[error.reason]},400);
      }
      return c.json({error:"Thunderbird credentials could not be imported. Import settings and enter passwords manually."},400);
    }
  });
  app.get("/api/send-requests", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const rows = db.query(`SELECT r.id,r.mailbox_id,r.approval_expires_at,d.mime_fields_json,d.encrypted_body,m.label,m.sender_name,COALESCE(m.sender_email,m.email) AS sender_email FROM send_requests r JOIN drafts d ON d.id=r.draft_id JOIN mailboxes m ON m.id=r.mailbox_id WHERE r.state='pending' AND r.approval_expires_at>? ORDER BY r.created_at`).all(new Date().toISOString()) as {id:string; mailbox_id:string; approval_expires_at:string; mime_fields_json:string; encrypted_body:string; label:string; sender_name:string; sender_email:string}[];
    return c.json({ requests: await Promise.all(rows.map(async r => ({ id:r.id, mailbox:r.label, senderName:r.sender_name, senderEmail:r.sender_email, expiresAt:r.approval_expires_at, ...JSON.parse(r.mime_fields_json), text:await decryptSecret(config.dataDir,r.mailbox_id,r.encrypted_body), reviewHash:sendReviewHash(r.mailbox_id,r.mime_fields_json,r.encrypted_body,r.sender_name,r.sender_email) }))) });
  });
  app.post("/api/send-requests/:id/:action", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const action = c.req.param("action"); if (action !== "approve" && action !== "reject") return c.json({ error: "Invalid action" }, 400);
    const id = c.req.param("id"), now = new Date().toISOString();
    const row = db.query(`SELECT r.mailbox_id,r.approval_expires_at,d.mime_fields_json,d.encrypted_body,m.sender_name,COALESCE(m.sender_email,m.email) AS sender_email FROM send_requests r JOIN drafts d ON d.id=r.draft_id JOIN mailboxes m ON m.id=r.mailbox_id WHERE r.id=? AND r.state='pending'`).get(id) as {mailbox_id:string; approval_expires_at:string; mime_fields_json:string; encrypted_body:string; sender_name:string; sender_email:string} | null;
    if (!row || row.approval_expires_at <= now) return c.json({ error: "Request is unavailable or expired." }, 409);
    let reviewHash: string | undefined;
    if (action === "approve") {
      const body = await c.req.json<{ reviewHash?: string }>().catch(() => ({} as { reviewHash?: string }));
      reviewHash = body.reviewHash;
      if (!reviewHash || reviewHash !== sendReviewHash(row.mailbox_id, row.mime_fields_json, row.encrypted_body, row.sender_name, row.sender_email)) return c.json({ error: "The request changed or has not been reviewed. Refresh it before approving." }, 409);
    }
    const deliveryOwner=randomBytes(16).toString("hex");
    const outcome = db.transaction(() => {
      const transitionTime=new Date().toISOString();
      if (action === "approve") {
        const since=new Date(Date.parse(transitionTime)-3600000).toISOString();
        const sent=db.query("SELECT COUNT(*) AS count FROM send_requests WHERE smtp_started_at>? AND smtp_started_at<=?").get(since,transitionTime) as {count:number};
        const limit=db.query("SELECT max_sends_per_hour FROM owner_settings WHERE id=1").get() as {max_sends_per_hour:number};
        if (sent.count >= limit.max_sends_per_hour) return "rate_limited";
      }
      const updated = db.query(`UPDATE send_requests SET state=?,updated_at=?,smtp_started_at=?,approved_payload_hash=?,approved_at=?,sending_owner=?,sending_lease_expires_at=?,sending_origin=? WHERE id=? AND state='pending' AND approval_expires_at>? AND EXISTS (SELECT 1 FROM drafts d WHERE d.id=send_requests.draft_id AND d.mailbox_id=? AND d.mime_fields_json=? AND d.encrypted_body=?) AND EXISTS (SELECT 1 FROM mailboxes m WHERE m.id=send_requests.mailbox_id AND m.sender_name=? AND COALESCE(m.sender_email,m.email)=?)`).run(action === "approve" ? "sending" : "rejected", transitionTime, action === "approve" ? transitionTime : null, reviewHash ?? null, action === "approve" ? transitionTime : null, action === "approve" ? deliveryOwner : null, action === "approve" ? Date.now()+DELIVERY_LEASE_MS : null, action === "approve" ? "owner" : null, id, transitionTime, row.mailbox_id, row.mime_fields_json, row.encrypted_body, row.sender_name, row.sender_email);
      if (!updated.changes) return "conflict";
      audit(db,{principalType:"owner",mailboxId:row.mailbox_id,action:action === "approve" ? "send.approve" : "send.reject",targetId:id,outcome:action === "approve" ? "sending" : "rejected",time:transitionTime});
      return "ok";
    }).immediate();
    if (outcome === "rate_limited") return c.json({ error:"Hourly send limit reached. Try again later." },429);
    if (outcome === "conflict") return c.json({ error: "Request already handled." }, 409);
    if (action === "reject") return c.json({ state: "rejected" });
    const stopLease=holdDeliveryLease(db,id,deliveryOwner);
    try {
      const fields=JSON.parse(row.mime_fields_json); const text=await decryptSecret(config.dataDir,row.mailbox_id,row.encrypted_body);
      await sendMail(db,config.dataDir,row.mailbox_id,{ ...fields,text },{name:row.sender_name,address:row.sender_email});
      if (!finishDelivery(db,id,deliveryOwner,row.mailbox_id,"sent")) return c.json({error:"Delivery could not be confirmed. Check the sent folder before retrying."},502);
      return c.json({state:"sent"});
    } catch {
      finishDelivery(db,id,deliveryOwner,row.mailbox_id,"delivery_unknown");
      return c.json({error:"Delivery could not be confirmed. Check the sent folder before retrying."},502);
    } finally { stopLease(); }
  });
  app.get("/api/settings",c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const row=db.query("SELECT personal_email FROM owner_settings WHERE id=1").get() as {personal_email:string|null};
    return c.json({personalEmail:row.personal_email});
  });
  app.put("/api/settings",async c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const parsed=z.object({personalEmail:z.union([z.string().email().max(254).refine(value=>Buffer.byteLength(value,"utf8")<=254 && !/[\r\n\0]/.test(value)),z.null()])}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"Enter a valid personal email address."},400);
    db.transaction(()=>{db.query("UPDATE owner_settings SET personal_email=? WHERE id=1").run(parsed.data.personalEmail);audit(db,{principalType:"owner",action:"settings.personal_email",outcome:parsed.data.personalEmail ? "updated" : "cleared"});})();
    return c.json({personalEmail:parsed.data.personalEmail});
  });
  app.get("/api/activity", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    return c.json({events:db.query("SELECT time,principal_type AS principalType,principal_id AS principalId,mailbox_id AS mailboxId,action,target_id AS targetId,outcome FROM audit_events ORDER BY time DESC,id DESC LIMIT 100").all()});
  });
  app.post("/api/agents", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const parsed=z.object({label:z.string().trim().min(1).max(80).refine(value=>!/[\r\n\0]/.test(value)),allowInboxSetup:z.boolean().default(false)}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"Agent name or setup permission is invalid."},400);
    const id=randomBytes(16).toString("hex"), token=randomBytes(32).toString("base64url"), now=new Date().toISOString();
    db.transaction(()=>{db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at,allow_inbox_setup) VALUES(?,?,?,?,?,?)").run(id,parsed.data.label,createHash("sha256").update(token).digest("hex"),token.slice(0,8),now,parsed.data.allowInboxSetup ? 1 : 0);audit(db,{principalType:"owner",principalId:id,action:"agent.create",targetId:id,outcome:"created",time:now});})();
    return c.json({id,label:parsed.data.label,token},201);
  });
  app.get("/api/agents", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ agents: db.query("SELECT id,label,token_prefix AS tokenPrefix,enabled,allow_inbox_setup AS allowInboxSetup,created_at AS createdAt,last_used_at AS lastUsedAt FROM agents ORDER BY label").all() });
  });
  app.put("/api/agents/:id/inbox-setup",async c=>{
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const parsed=z.object({enabled:z.boolean()}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"Invalid setup permission."},400);
    const id=c.req.param("id");
    const updated=db.transaction(()=>{const result=db.query("UPDATE agents SET allow_inbox_setup=? WHERE id=? AND enabled=1").run(parsed.data.enabled ? 1 : 0,id);if(result.changes)audit(db,{principalType:"owner",principalId:id,action:"agent.inbox.setup_permission",targetId:id,outcome:parsed.data.enabled ? "enabled" : "disabled"});return result.changes;})();
    if (!updated) return c.json({error:"Active agent not found."},404);
    return c.json({enabled:parsed.data.enabled});
  });
  app.get("/api/agents/:id/inbox",c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const id=c.req.param("id"); if (!db.query("SELECT 1 FROM agents WHERE id=?").get(id)) return c.json({error:"Agent not found."},404);
    const row=db.query("SELECT mailbox_id FROM agent_inboxes WHERE agent_id=?").get(id) as {mailbox_id:string} | null;
    return c.json({mailboxId:row?.mailbox_id ?? null});
  });
  app.put("/api/agents/:id/inbox",async c => {
    if (!isOwnerAuthorized(c.req.header("cookie"),db)) return c.json({error:"Unauthorized"},401);
    const parsed=z.object({mailboxId:z.string().min(1).max(128).nullable()}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"Invalid inbox selection."},400);
    const id=c.req.param("id"), mailboxId=parsed.data.mailboxId;
    try {
      const outcome=db.transaction(()=>{
        const agent=db.query("SELECT enabled FROM agents WHERE id=?").get(id) as {enabled:number} | null;
        if (!agent) return "not_found";
        if (!agent.enabled) return "revoked";
        if (mailboxId) {
          const box=db.query("SELECT smtp_enabled FROM mailboxes WHERE id=?").get(mailboxId) as {smtp_enabled:number} | null;
          if (!box) return "mailbox_missing";
          if (!box.smtp_enabled) return "read_only";
          db.query("INSERT INTO agent_inboxes(agent_id,mailbox_id,created_at) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET mailbox_id=excluded.mailbox_id,created_at=excluded.created_at").run(id,mailboxId,new Date().toISOString());
        } else db.query("DELETE FROM agent_inboxes WHERE agent_id=?").run(id);
        audit(db,{principalType:"owner",principalId:id,mailboxId:mailboxId ?? undefined,action:"agent.inbox",targetId:id,outcome:mailboxId ? "assigned" : "cleared"});
        return "ok";
      })();
      if (outcome==="not_found") return c.json({error:"Agent not found."},404);
      if (outcome==="revoked") return c.json({error:"Agent is revoked."},409);
      if (outcome==="mailbox_missing") return c.json({error:"Mailbox not found."},404);
      if (outcome==="read_only") return c.json({error:"Enable SMTP before assigning this mailbox as an agent inbox."},400);
      return c.json({mailboxId});
    } catch (error) {
      if (error instanceof SQLiteError && [1555,2067].includes(error.errno)) return c.json({error:"That mailbox is already assigned to another agent."},409);
      return c.json({error:"Agent inbox could not be saved."},500);
    }
  });
  app.get("/api/agents/:id/grants", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const agentId = c.req.param("id");
    if (!db.query("SELECT 1 FROM agents WHERE id=?").get(agentId)) return c.json({ error: "Agent not found." }, 404);
    return c.json({ grants: db.query("SELECT mailbox_id AS mailboxId,capability FROM agent_mailbox_grants WHERE agent_id=? ORDER BY mailbox_id,capability").all(agentId) });
  });
  app.put("/api/agents/:id/grants", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ grants?: { mailboxId: string; capabilities: string[] }[] }>().catch((): { grants?: { mailboxId: string; capabilities: string[] }[] } => ({}));
    const allowedCapabilities = new Set(["mail.read", "mail.search", "mail.draft", "mail.reply", "mail.forward", "mail.send.request", "mail.modify", "mail.delete", "mail.attachments"]);
    if (!Array.isArray(body.grants) || body.grants.length > 100 || body.grants.some((grant) => !grant || typeof grant.mailboxId !== "string" || !Array.isArray(grant.capabilities) || grant.capabilities.some((capability) => !allowedCapabilities.has(capability)))) return c.json({ error: "Invalid mailbox grants." }, 400);
    const agentId = c.req.param("id");
    const exists = db.query("SELECT 1 FROM agents WHERE id=?").get(agentId);
    if (!exists) return c.json({ error: "Agent not found." }, 404);
    const apply = db.transaction(() => {
      db.query("DELETE FROM agent_mailbox_grants WHERE agent_id=?").run(agentId);
      const insert = db.query("INSERT INTO agent_mailbox_grants(agent_id,mailbox_id,capability,created_at) VALUES(?,?,?,?)");
      for (const grant of body.grants!) for (const capability of new Set(grant.capabilities)) insert.run(agentId, grant.mailboxId, capability, new Date().toISOString());
    });
    try { apply(); } catch (error) {
      if (error instanceof SQLiteError && error.errno === 787) return c.json({ error: "Unknown mailbox or invalid grants." }, 400);
      const requestId = randomBytes(8).toString("hex");
      console.error(`Grant update failed (${requestId}): ${error instanceof SQLiteError ? `SQLite ${error.errno}` : error instanceof Error ? error.name : "unknown error"}`);
      return c.json({ error: "Grants could not be saved", requestId }, 500);
    }
    return c.json({ saved: true });
  });
  app.post("/api/agents/:id/rotate-token", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const agentId = c.req.param("id");
    if (!db.query("SELECT 1 FROM agents WHERE id=?").get(agentId)) return c.json({ error: "Agent not found." }, 404);
    const token = randomBytes(32).toString("base64url");
    db.query("UPDATE agents SET token_hash=?,token_prefix=? WHERE id=?").run(createHash("sha256").update(token).digest("hex"), token.slice(0, 8), agentId);
    return c.json({ token });
  });
  app.delete("/api/agents/:id", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const agentId = c.req.param("id");
    const changed=db.transaction(()=>{const result=db.query("UPDATE agents SET enabled=0 WHERE id=?").run(agentId);if(result.changes){db.query("DELETE FROM agent_inboxes WHERE agent_id=?").run(agentId);audit(db,{principalType:"owner",principalId:agentId,action:"agent.revoke",targetId:agentId,outcome:"revoked"});}return result.changes;})();
    if (changed === 0) return c.json({ error: "Agent not found." }, 404);
    return c.json({ revoked: true });
  });
  app.all("/mcp", async (c) => {
    if (!allowRate(rateCounters, "mcp", 600, 60_000)) return c.json({ error: "Rate limit exceeded." }, 429);
    const bearer = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const authInfo = bearer ? authenticateAgentToken(db, bearer) : null;
    if (!authInfo) return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    return mcpHandler.fetch(c.req.raw, { authInfo });
  });
  app.get("/", (c) => c.html(renderDashboard()));
  const server = Bun.serve({ hostname: config.bind, port: config.port, fetch: app.fetch });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      clearInterval(recoveryTimer);
      await pollScheduler.stop();
      await mcpHandler.close();
      server.stop(true);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      await releaseLock();
    })();
    return shutdownPromise;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  console.log(`Postmote listening at http://${config.bind}:${config.port}`);
} else {
  console.error("Usage: postmote [--version|init|serve|doctor|backup <directory>|config show|mcp stdio]");
  process.exitCode = 2;
}

function sendReviewHash(mailboxId: string, fields: string, encryptedBody: string, senderName: string, senderEmail: string): string {
  return createHash("sha256").update(JSON.stringify([mailboxId, fields, encryptedBody, senderName, senderEmail])).digest("hex");
}

function isOwnerAuthorized(cookie: string | undefined, db: import("bun:sqlite").Database): boolean {
  const session = /(?:^|;\s*)postmote_session=([^;]+)/.exec(cookie ?? "")?.[1];
  if (!session) return false;
  const idHash = createHash("sha256").update(session).digest("hex");
  return db.query("SELECT 1 FROM owner_sessions WHERE id_hash=? AND revoked_at IS NULL AND expires_at > ?").get(idHash, new Date().toISOString()) !== null;
}

function allowRate(counters: Map<string, { count: number; resetAt: number }>, key: string, maximum: number, windowMs: number): boolean {
  const now = Date.now();
  const current = counters.get(key);
  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= maximum) return false;
  current.count++;
  return true;
}

function renderDashboard(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postmote</title>
<style>
:root{font:16px/1.5 system-ui,sans-serif;color:#18212b;background:#f5f7f9}*{box-sizing:border-box}body{margin:0}header{background:#132b3a;color:white;padding:1rem max(1rem,calc((100vw - 960px)/2));display:flex;align-items:center;justify-content:space-between}header h1{font-size:1.25rem;margin:0}main{max-width:960px;margin:2rem auto;padding:0 1rem}.panel{background:white;border:1px solid #d7dee5;border-radius:12px;padding:1.25rem;margin:1rem 0;box-shadow:0 2px 8px #142a3a0b}h2{font-size:1.15rem;margin:.15rem 0 1rem}h3{font-size:1rem;margin:1rem 0 .5rem}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem 1rem}.field{display:flex;flex-direction:column;gap:.25rem}.wide{grid-column:1/-1}label{font-weight:600;font-size:.92rem}input,select,button{max-width:100%;min-width:0;font:inherit;border:1px solid #9aa8b5;border-radius:7px;padding:.55rem .65rem;background:white;color:#18212b}input:focus,select:focus,button:focus-visible{outline:3px solid #007e9e;outline-offset:2px}button{cursor:pointer;font-weight:650;background:#075b74;color:white;border-color:#075b74}.secondary{background:white;color:#18212b;border-color:#8797a4}.actions{display:flex;gap:.65rem;align-items:center;flex-wrap:wrap;margin-top:1rem}.status{min-height:1.5rem;color:#8b260f}.muted{color:#4c5e6d}.row{border-top:1px solid #e2e7eb;padding:.7rem 0}.check{display:flex;gap:.6rem;align-items:center}.check input{width:1.1rem;height:1.1rem}.token{padding:.7rem;background:#f1f4f6;border-radius:6px;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:620px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}main{margin:1rem auto}.panel{padding:1rem}}
</style></head><body><header><h1>Postmote</h1><button id="logout" class="secondary" hidden>Sign out</button></header><main>
<section id="setup" class="panel" hidden><h2>Set up owner access</h2><p class="muted">Choose a local password of at least 12 characters. Postmote stores only a password hash.</p><form id="setupForm"><div class="field"><label for="setupPassword">Owner password</label><input id="setupPassword" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div><div class="actions"><button>Initialize</button></div></form><p id="setupStatus" class="status" role="status" aria-live="polite"></p></section>
<section id="login" class="panel" hidden><h2>Sign in</h2><form id="loginForm"><div class="field"><label for="loginPassword">Owner password</label><input id="loginPassword" type="password" autocomplete="current-password" required></div><div class="actions"><button>Sign in</button></div></form><p id="loginStatus" class="status" role="status" aria-live="polite"></p></section>
<div id="app" hidden><section class="panel"><h2 id="mailboxHeading" tabindex="-1">Add mailbox</h2><p class="muted">Import Thunderbird settings and saved passwords, or enter a password or app password manually. OAuth accounts are not supported.</p><div class="actions"><button type="button" id="findThunderbird" class="secondary">Find Thunderbird profiles</button></div><div class="field"><label for="thunderbirdPrimary">Thunderbird primary password (if set)</label><input id="thunderbirdPrimary" type="password" maxlength="1024" autocomplete="off"></div><div id="thunderbirdProfiles" aria-live="polite"></div><p id="thunderbirdStatus" class="status" role="status" aria-live="polite"></p><form id="mailboxForm"><h3>Identity</h3><div class="grid">
<div class="field"><label for="label">Display label</label><input id="label" maxlength="80" autocomplete="off"></div><div class="field"><label for="email">Email address</label><input id="email" type="email" maxlength="254" autocomplete="email" required></div>
<div class="field"><label for="senderName">Sender name</label><input id="senderName" maxlength="100" autocomplete="off"></div><div class="field"><label for="senderEmail">Sender email</label><input id="senderEmail" type="email" maxlength="254" autocomplete="off"></div></div>
<h3>Incoming mail (IMAP)</h3><div class="grid"><div class="field"><label for="imapHost">IMAP host</label><input id="imapHost" maxlength="253" autocomplete="off" required></div><div class="field"><label for="imapPort">Port</label><input id="imapPort" type="number" min="1" max="65535" value="993" required></div><div class="field"><label for="imapSecurity">Encryption</label><select id="imapSecurity"><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></div><div class="field"><label for="username">Username</label><input id="username" maxlength="320" autocomplete="username" required></div><div class="field"><label for="password">Password or app password</label><input id="password" type="password" maxlength="4096" autocomplete="new-password" required></div><div class="field"><label for="pollSeconds">Polling interval (seconds)</label><input id="pollSeconds" type="number" min="60" max="3600" value="120" required></div><div class="field wide"><label for="mailboxRoot">Mailbox root (optional)</label><input id="mailboxRoot" maxlength="512" autocomplete="off"></div></div>
<h3>Outgoing mail (SMTP)</h3><label class="check"><input id="smtpDisabled" type="checkbox"> Disable sending (read-only mailbox)</label><div id="smtpFields" class="grid" style="margin-top:.8rem"><div class="field"><label for="smtpHost">SMTP host</label><input id="smtpHost" maxlength="253" required></div><div class="field"><label for="smtpPort">Port</label><input id="smtpPort" type="number" min="1" max="65535" value="465" required></div><div class="field"><label for="smtpSecurity">Encryption</label><select id="smtpSecurity"><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></div><div class="field"><label for="smtpUsername">Username</label><input id="smtpUsername" maxlength="320" autocomplete="username" required></div><div class="field"><label for="smtpPassword">Password or app password</label><input id="smtpPassword" type="password" maxlength="4096" autocomplete="new-password" required></div><div class="field"><label class="check"><input id="sameImap" type="checkbox"> Use IMAP username and password</label></div></div>
<p id="passwordHint" class="muted" hidden>Leave passwords blank to keep them. To test a connection, enter its password again.</p><h3>Agent access</h3><p class="muted">New mailboxes have no agent access. Set grants after saving.</p><div class="actions"><button id="testImap" class="secondary" type="button">Test IMAP</button><button id="testSmtp" class="secondary" type="button">Test SMTP</button><button id="saveMailbox">Save mailbox</button><button type="button" id="cancelMailboxEdit" class="secondary" hidden>Cancel edit</button></div><p id="testStatus" class="muted" role="status" aria-live="polite"></p></form><p id="mailboxStatus" class="status" role="status" aria-live="polite"></p></section>
<section class="panel"><h2>Personal email</h2><p class="muted">A dedicated agent inbox can send directly to this address. Other recipients require your approval.</p><form id="personalEmailForm"><div class="field"><label for="personalEmail">Your email address</label><input id="personalEmail" type="email" maxlength="254" autocomplete="email"></div><div class="actions"><button>Save personal email</button></div></form><p id="personalEmailStatus" class="status" role="status" aria-live="polite"></p></section>
<section class="panel"><h2>Pending email requests</h2><div id="sendRequests" aria-live="polite"></div><button type="button" id="refreshRequests" class="secondary">Refresh requests</button></section><section class="panel"><h2>Mailboxes</h2><div id="mailboxes" aria-live="polite"></div></section>
<section class="panel"><h2>Activity</h2><div id="activity" aria-live="polite"></div><button type="button" id="refreshActivity" class="secondary">Refresh activity</button></section>
<section class="panel"><h2>Agents</h2><form id="agentForm"><div class="grid"><div class="field"><label for="agentLabel">Agent name</label><input id="agentLabel" maxlength="80" required></div><div class="field"><label>Mailbox permissions</label><div id="grantChoices" class="muted">Add a mailbox first.</div></div></div><label class="check"><input id="allowInboxSetup" type="checkbox"> Allow this agent to configure its own existing IMAP/SMTP account</label><p class="muted">The agent supplies its own credentials when setting up the inbox.</p><div class="actions"><button>Create agent token</button></div></form><p id="agentStatus" class="status" role="status" aria-live="polite"></p><div id="tokenPanel" hidden><p>Copy this token now. It will not be shown again.</p><p id="agentToken" class="token"></p></div><div id="agents"></div></section></div>
</main><script>
let editingMailbox=null;const byId=id=>document.getElementById(id);const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok){let message=data.error||'Request failed';if(data.fields)message+=': '+Object.entries(data.fields).map(([field,errors])=>field+' '+errors.join(', ')).join('; ');throw new Error(message)}return data};const show=(id,on)=>byId(id).hidden=!on;const say=(id,text)=>byId(id).textContent=text;
async function refresh(){const state=await api('/api/auth/me');show('setup',!state.initialized);show('login',state.initialized&&!state.authenticated);show('app',state.authenticated);show('logout',state.authenticated);if(state.authenticated){await loadMailboxes();await loadAgents();await loadRequests();await loadActivity();await loadPersonalEmail()}}
byId('setupForm').addEventListener('submit',async e=>{e.preventDefault();say('setupStatus','');try{await api('/api/setup/initialize',{method:'POST',body:JSON.stringify({password:byId('setupPassword').value})});byId('setupPassword').value='';await refresh()}catch(err){say('setupStatus',err.message)}});
byId('loginForm').addEventListener('submit',async e=>{e.preventDefault();say('loginStatus','');try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:byId('loginPassword').value})});byId('loginPassword').value='';await refresh()}catch(err){say('loginStatus',err.message)}});
byId('logout').addEventListener('click',async()=>{byId('thunderbirdPrimary').value='';await api('/api/auth/logout',{method:'POST'});await refresh()});
byId('smtpSecurity').addEventListener('change',()=>{byId('smtpPort').value=byId('smtpSecurity').value==='tls'?'465':'587'});
function syncMailboxForm(){const disabled=byId('smtpDisabled').checked,same=byId('sameImap').checked;byId('smtpFields').hidden=disabled;for(const id of ['smtpHost','smtpPort','smtpSecurity'])byId(id).required=!disabled;for(const id of ['smtpUsername','smtpPassword'])byId(id).disabled=disabled||same;byId('smtpUsername').required=!disabled&&!same;byId('smtpPassword').required=!disabled&&!same&&!editingMailbox;byId('password').required=!editingMailbox}
byId('smtpDisabled').addEventListener('change',syncMailboxForm);
byId('sameImap').addEventListener('change',syncMailboxForm);
function resetMailboxForm(){editingMailbox=null;byId('mailboxForm').reset();byId('imapPort').value='993';byId('smtpPort').value='465';byId('pollSeconds').value='120';byId('mailboxHeading').textContent='Add mailbox';byId('saveMailbox').textContent='Save mailbox';byId('cancelMailboxEdit').hidden=true;byId('passwordHint').hidden=true;passedImap=null;passedSmtp=null;syncMailboxForm()}
byId('cancelMailboxEdit').addEventListener('click',()=>{resetMailboxForm();say('mailboxStatus','Edit cancelled.');say('testStatus','')});
function beginMailboxEdit(box){resetMailboxForm();editingMailbox=box.id;for(const key of ['label','email','senderName','senderEmail','imapHost','imapPort','imapSecurity','username','mailboxRoot','pollSeconds','smtpHost','smtpPort','smtpSecurity','smtpUsername'])if(byId(key))byId(key).value=box[key] ?? '';byId('smtpDisabled').checked=!box.smtpEnabled;byId('mailboxHeading').textContent='Edit mailbox';byId('saveMailbox').textContent='Save changes';byId('cancelMailboxEdit').hidden=false;byId('passwordHint').hidden=false;syncMailboxForm();say('mailboxStatus','');say('testStatus','');byId('mailboxHeading').focus()}
byId('findThunderbird').addEventListener('click',async()=>{const list=byId('thunderbirdProfiles');list.textContent='Looking for profiles...';say('thunderbirdStatus','');try{const data=await api('/api/thunderbird/profiles');list.replaceChildren();for(const [profileIndex,profile] of data.profiles.entries()){for(const [accountIndex,account] of profile.accounts.entries()){const row=document.createElement('div');row.className='row';const title=document.createElement('p');title.textContent=profile.name+': '+account.email;row.append(title);const settings=document.createElement('button');settings.type='button';settings.className='secondary';settings.textContent='Fill settings';settings.addEventListener('click',()=>{resetMailboxForm();for(const key of ['label','email','senderName','imapHost','imapPort','imapSecurity','username','smtpHost','smtpPort','smtpSecurity','smtpUsername'])if(account[key]!=null&&byId(key))byId(key).value=account[key];byId('password').value='';byId('smtpPassword').value='';byId('mailboxForm').dispatchEvent(new Event('input'));say('testStatus',account.imapSecurity&&account.smtpSecurity?'Settings loaded. Enter passwords and test connections.':'Unsupported or missing encryption settings. Review all settings before saving.')});row.append(settings);const importButton=document.createElement('button');importButton.type='button';importButton.textContent='Import saved passwords';importButton.addEventListener('click',async()=>{importButton.disabled=true;say('thunderbirdStatus','Importing account...');try{await api('/api/thunderbird/import',{method:'POST',body:JSON.stringify({profileIndex,accountIndex,email:account.email,primaryPassword:byId('thunderbirdPrimary').value})});say('thunderbirdStatus','Account imported. New mailboxes have no agent permissions.');await loadMailboxes();await loadAgents()}catch(err){say('thunderbirdStatus',err.message)}finally{byId('thunderbirdPrimary').value='';importButton.disabled=false}});row.append(document.createTextNode(' '),importButton);list.append(row)}}if(!list.children.length)list.textContent='No IMAP accounts found.'}catch(err){list.textContent=err.message}});
async function loadPersonalEmail(){const settings=await api('/api/settings');byId('personalEmail').value=settings.personalEmail ?? ''}
byId('personalEmailForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;say('personalEmailStatus','Saving...');try{await api('/api/settings',{method:'PUT',body:JSON.stringify({personalEmail:byId('personalEmail').value.trim() || null})});say('personalEmailStatus','Personal email saved.')}catch(err){say('personalEmailStatus',err.message)}finally{button.disabled=false}});
async function loadRequests(){const list=byId('sendRequests');try{const data=await api('/api/send-requests');list.replaceChildren();if(!data.requests.length){list.textContent='No pending requests.';return}for(const request of data.requests){const row=document.createElement('div');row.className='row';const details=document.createElement('pre');details.style.whiteSpace='pre-wrap';details.style.overflowWrap='anywhere';details.textContent='From: '+(request.senderName?request.senderName+' <'+request.senderEmail+'>':request.senderEmail)+'\\nTo: '+(Array.isArray(request.to)?request.to.join(', '):request.to)+(request.cc&&request.cc.length?'\\nCc: '+request.cc.join(', '):'')+(request.bcc&&request.bcc.length?'\\nBcc: '+request.bcc.join(', '):'')+(request.inReplyTo?'\\nIn reply to: '+request.inReplyTo:'')+'\\nSubject: '+request.subject+'\\nExpires: '+request.expiresAt+'\\n\\n'+request.text;row.append(details);for(const action of ['approve','reject']){const button=document.createElement('button');button.type='button';button.textContent=action==='approve'?'Approve and send':'Reject';button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/send-requests/'+request.id+'/'+action,{method:'POST',body:JSON.stringify({reviewHash:request.reviewHash})});await loadRequests();await loadActivity()}catch(err){alert(err.message);await loadRequests()}});row.append(button)}list.append(row)}}catch(err){list.textContent=err.message}}
byId('refreshRequests').addEventListener('click',loadRequests);
async function loadActivity(){const list=byId('activity');list.textContent='Loading activity...';try{const data=await api('/api/activity');list.replaceChildren();if(!data.events.length){list.textContent='No recorded activity.';return}for(const event of data.events){const row=document.createElement('div');row.className='row';row.textContent=event.time+' · '+event.action+' · '+event.outcome;list.append(row)}}catch(err){list.textContent=err.message}}
byId('refreshActivity').addEventListener('click',loadActivity);

let passedImap=null,passedSmtp=null;const mailboxPayload=()=>{const same=byId('sameImap').checked,disabled=byId('smtpDisabled').checked;return {label:byId('label').value,email:byId('email').value,senderName:byId('senderName').value,senderEmail:byId('senderEmail').value||undefined,imapHost:byId('imapHost').value,imapPort:Number(byId('imapPort').value),imapSecurity:byId('imapSecurity').value,username:byId('username').value,password:byId('password').value,mailboxRoot:byId('mailboxRoot').value||undefined,pollSeconds:Number(byId('pollSeconds').value),smtpEnabled:!disabled,smtpHost:disabled?undefined:byId('smtpHost').value,smtpPort:disabled?undefined:Number(byId('smtpPort').value),smtpSecurity:disabled?undefined:byId('smtpSecurity').value,smtpUsername:disabled?undefined:(same?byId('username').value:byId('smtpUsername').value),smtpPassword:disabled?undefined:(same?byId('password').value:byId('smtpPassword').value)}};const fingerprint=()=>JSON.stringify(mailboxPayload());
byId('mailboxForm').addEventListener('input',()=>{passedImap=null;passedSmtp=null;say('testStatus','Form changes clear previous connection test results.')});
async function testMailbox(kind){const button=byId(kind==='imap'?'testImap':'testSmtp');button.disabled=true;say('testStatus','Testing '+kind.toUpperCase()+' connection…');try{const result=await api('/api/mailboxes/test-'+kind,{method:'POST',body:JSON.stringify(mailboxPayload())});if(!result.ok)throw new Error(result.message);if(kind==='imap')passedImap=fingerprint();else passedSmtp=fingerprint();say('testStatus',kind.toUpperCase()+': '+result.message)}catch(err){say('testStatus',kind.toUpperCase()+' test failed: '+err.message)}finally{button.disabled=false}}
byId('testImap').addEventListener('click',()=>testMailbox('imap'));byId('testSmtp').addEventListener('click',()=>testMailbox('smtp'));
byId('mailboxForm').addEventListener('submit',async e=>{e.preventDefault();if((passedImap!==fingerprint()||(!byId('smtpDisabled').checked&&passedSmtp!==fingerprint()))&&!confirm('The current settings have not passed both connection tests. Save them anyway?'))return;const save=byId('saveMailbox');save.disabled=true;say('mailboxStatus','Saving mailbox...');try{const payload=mailboxPayload();if(editingMailbox){if(!payload.password)delete payload.password;if(!payload.smtpPassword)delete payload.smtpPassword;if(byId('sameImap').checked){delete payload.smtpUsername;payload.useImapForSmtp=true}await api('/api/mailboxes/'+editingMailbox,{method:'PATCH',body:JSON.stringify(payload)})}else await api('/api/mailboxes',{method:'POST',body:JSON.stringify(payload)});resetMailboxForm();say('testStatus','');say('mailboxStatus','Mailbox saved.');await loadMailboxes();await loadAgents();await loadRequests()}catch(err){say('mailboxStatus',err.message)}finally{save.disabled=false}});
const capabilities=['mail.read','mail.search','mail.draft','mail.reply','mail.forward','mail.send.request','mail.modify','mail.delete','mail.attachments'];
async function loadMailboxes(){const data=await api('/api/mailboxes');const list=byId('mailboxes');list.replaceChildren();const choices=byId('grantChoices');choices.replaceChildren();if(!data.mailboxes.length){list.textContent='No mailboxes configured.';choices.textContent='Add a mailbox first.';return}for(const box of data.mailboxes){const row=document.createElement('div');row.className='row';const summary=document.createElement('span');summary.textContent=box.label+' · '+box.email+' · IMAP '+box.imapSecurity.toUpperCase()+' · '+(box.smtpEnabled?'SMTP enabled':'read only');row.append(summary);const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Edit mailbox';edit.addEventListener('click',()=>beginMailboxEdit(box));const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove mailbox';remove.addEventListener('click',async()=>{if(!confirm('Remove this mailbox and its local drafts, send history and index? Mail on the server is not deleted.'))return;remove.disabled=true;try{await api('/api/mailboxes/'+box.id,{method:'DELETE'});if(editingMailbox===box.id)resetMailboxForm();await loadMailboxes();await loadAgents();await loadRequests();await loadActivity();say('mailboxStatus','Mailbox removed.')}catch(err){say('mailboxStatus',err.message);remove.disabled=false}});actions.append(edit,remove);row.append(actions);list.append(row);const group=document.createElement('fieldset');group.className='row';const legend=document.createElement('legend');legend.textContent=box.label+' ('+box.email+')';group.append(legend);for(const capability of capabilities){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=capability;input.dataset.mailboxId=box.id;label.append(input,document.createTextNode(capability));group.append(label)}choices.append(group)}}
byId('agentForm').addEventListener('submit',async e=>{e.preventDefault();say('agentStatus','');show('tokenPanel',false);try{const agent=await api('/api/agents',{method:'POST',body:JSON.stringify({label:byId('agentLabel').value,allowInboxSetup:byId('allowInboxSetup').checked})});say('agentToken',agent.token);show('tokenPanel',true);const grants=[...document.querySelectorAll('#grantChoices input:checked')].reduce((all,input)=>{let grant=all.find(item=>item.mailboxId===input.dataset.mailboxId);if(!grant){grant={mailboxId:input.dataset.mailboxId,capabilities:[]};all.push(grant)}grant.capabilities.push(input.value);return all},[]);if(grants.length)await api('/api/agents/'+agent.id+'/grants',{method:'PUT',body:JSON.stringify({grants})});byId('agentLabel').value='';byId('allowInboxSetup').checked=false;await loadAgents()}catch(err){say('agentStatus',err.message)}});
async function editGrants(agent,container){
  container.replaceChildren();const message=document.createElement('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.textContent='Loading permissions...';container.append(message);
  try{
    const [boxes,current,inbox]=await Promise.all([api('/api/mailboxes'),api('/api/agents/'+agent.id+'/grants'),api('/api/agents/'+agent.id+'/inbox')]);
    message.textContent='Choose permissions for '+agent.label+'.';const setupForm=document.createElement('form');const setupLabel=document.createElement('label');setupLabel.className='check';const setupInput=document.createElement('input');setupInput.type='checkbox';setupInput.checked=!!agent.allowInboxSetup;setupLabel.append(setupInput,document.createTextNode(' Allow this agent to configure its own existing IMAP/SMTP account'));const setupSave=document.createElement('button');setupSave.type='submit';setupSave.className='secondary';setupSave.textContent='Save setup permission';setupForm.append(setupLabel,setupSave);setupForm.addEventListener('submit',async e=>{e.preventDefault();setupSave.disabled=true;try{await api('/api/agents/'+agent.id+'/inbox-setup',{method:'PUT',body:JSON.stringify({enabled:setupInput.checked})});agent.allowInboxSetup=setupInput.checked;message.textContent='Setup permission saved.'}catch(err){message.textContent=err.message}finally{setupSave.disabled=false}});container.append(setupForm);const inboxForm=document.createElement('form');const inboxLabel=document.createElement('label');inboxLabel.className='field';inboxLabel.textContent='Dedicated agent inbox';const inboxSelect=document.createElement('select');inboxSelect.setAttribute('aria-label','Dedicated agent inbox');const noInbox=document.createElement('option');noInbox.value='';noInbox.textContent='No dedicated inbox';inboxSelect.append(noInbox);for(const box of boxes.mailboxes){const option=document.createElement('option');option.value=box.id;option.textContent=box.label+' ('+box.email+')'+(box.smtpEnabled?'':' - SMTP disabled');option.disabled=!box.smtpEnabled;option.selected=box.id===inbox.mailboxId;inboxSelect.append(option)}const explanation=document.createElement('p');explanation.className='muted';explanation.textContent='The assigned agent has full mailbox permissions on this inbox and can send directly to your configured personal address. Other recipients require your approval. Explicit permissions remain after unassigning.';const inboxSave=document.createElement('button');inboxSave.type='submit';inboxSave.className='secondary';inboxSave.textContent='Save dedicated inbox';inboxLabel.append(document.createTextNode(' '),inboxSelect);inboxForm.append(inboxLabel,explanation,inboxSave);container.append(inboxForm);inboxForm.addEventListener('submit',async e=>{e.preventDefault();const mailboxId=inboxSelect.value || null;const selected=boxes.mailboxes.find(box=>box.id===mailboxId);if(mailboxId&&mailboxId!==inbox.mailboxId&&!confirm('Give '+agent.label+' full mailbox access to '+selected.email+'?'))return;inboxSave.disabled=true;message.textContent='Saving dedicated inbox...';try{await api('/api/agents/'+agent.id+'/inbox',{method:'PUT',body:JSON.stringify({mailboxId})});inbox.mailboxId=mailboxId;message.textContent='Dedicated inbox saved.'}catch(err){message.textContent=err.message}finally{inboxSave.disabled=false}});const form=document.createElement('form');if(!boxes.mailboxes.length){const empty=document.createElement('p');empty.textContent='No mailboxes configured yet.';form.append(empty)}
    for(const box of boxes.mailboxes){const group=document.createElement('fieldset');group.className='row';const legend=document.createElement('legend');legend.textContent=box.label+' ('+box.email+')';group.append(legend);
      for(const capability of capabilities){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=capability;input.dataset.mailboxId=box.id;input.checked=current.grants.some(g=>g.mailboxId===box.id&&g.capability===capability);label.append(input,document.createTextNode(capability));group.append(label)}form.append(group)}
    const save=document.createElement('button');save.type='submit';save.textContent='Save permissions';form.append(save);container.append(form);
    form.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;message.textContent='Saving permissions...';try{const grants=[...form.querySelectorAll('input:checked')].reduce((all,input)=>{let grant=all.find(item=>item.mailboxId===input.dataset.mailboxId);if(!grant){grant={mailboxId:input.dataset.mailboxId,capabilities:[]};all.push(grant)}grant.capabilities.push(input.value);return all},[]);await api('/api/agents/'+agent.id+'/grants',{method:'PUT',body:JSON.stringify({grants})});message.textContent='Permissions saved.'}catch(err){message.textContent=err.message}finally{save.disabled=false}});
  }catch(err){message.textContent=err.message}
}
async function loadAgents(){const data=await api('/api/agents');const list=byId('agents');list.replaceChildren();for(const agent of data.agents){const row=document.createElement('div');row.className='row';const title=document.createElement('span');title.textContent=agent.label+' · token '+agent.tokenPrefix+'… · '+(agent.enabled?'enabled':'revoked');row.append(title);if(agent.enabled){const editor=document.createElement('div');editor.hidden=true;const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Edit permissions';edit.setAttribute('aria-expanded','false');edit.addEventListener('click',()=>{editor.hidden=!editor.hidden;edit.setAttribute('aria-expanded',String(!editor.hidden));if(!editor.hidden)void editGrants(agent,editor)});row.append(document.createTextNode(' '),edit);const rotate=document.createElement('button');rotate.type='button';rotate.className='secondary';rotate.textContent='Rotate token';rotate.addEventListener('click',async()=>{try{const result=await api('/api/agents/'+agent.id+'/rotate-token',{method:'POST'});say('agentToken',result.token);show('tokenPanel',true);await loadAgents()}catch(err){say('agentStatus',err.message)}});const revoke=document.createElement('button');revoke.type='button';revoke.className='secondary';revoke.textContent='Revoke';revoke.addEventListener('click',async()=>{if(!confirm('Revoke this agent token?'))return;try{await api('/api/agents/'+agent.id,{method:'DELETE'});await loadAgents()}catch(err){say('agentStatus',err.message)}});row.append(document.createTextNode(' '),rotate,document.createTextNode(' '),revoke,editor)}list.append(row)}}
refresh().catch(err=>console.error('Postmote startup failed',err));
</script></body></html>`;
}
