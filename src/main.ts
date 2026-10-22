import { createHash, randomBytes } from "node:crypto";
import { SQLiteError } from "bun:sqlite";
import { Hono } from "hono";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { imapConnectionInputSchema, mailboxInputSchema, smtpConnectionInputSchema } from "./mailbox.ts";
import { encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "./vault.ts";
import { authenticateAgentToken, createAgentMcpHandler } from "./mcp.ts";
import { testImapConnection, testSmtpConnection } from "./mail/connections.ts";
import { acquireDaemonLock } from "./daemon-lock.ts";

const VERSION = "0.1.0";
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
} else if (command[0] === "doctor") {
  const db = await openDatabase(config.dataDir);
  const initialized = db.query("SELECT 1 FROM owner_credentials WHERE id=1").get() !== null;
  db.close();
  console.log(JSON.stringify({ version: VERSION, bind: config.bind, port: config.port, dataDir: config.dataDir, initialized, masterKey: Bun.file(`${config.dataDir}/master.key`).size > 0 ? "present" : "missing" }, null, 2));
} else if (command[0] === "config" && command[1] === "show") {
  console.log(JSON.stringify({ bind: config.bind, port: config.port, dataDir: config.dataDir, pollSeconds: config.pollSeconds, logLevel: config.logLevel }, null, 2));
} else if (command[0] === "mcp" && command[1] === "stdio") {
  console.error("Postmote MCP forwarding is not available yet. Start the daemon after a later release that includes MCP transport support.");
  process.exitCode = 2;
} else if (command[0] === "serve") {
  await ensureMasterKey(config.dataDir);
  const releaseLock = await acquireDaemonLock(config.dataDir);
  const db = await openDatabase(config.dataDir);
  const app = new Hono();
  const mcpHandler = createAgentMcpHandler(db);
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
    const values = parsed.data;
    const id = randomBytes(16).toString("hex");
    const secretBundle = JSON.stringify({ imapPassword: values.password, smtpPassword: values.smtpEnabled ? (values.smtpPassword ?? "") : null });
    const encrypted = await encryptSecret(config.dataDir, id, secretBundle);
    const now = new Date().toISOString();
    try {
      db.query(`INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,encrypted_secret,poll_seconds,created_at,updated_at,sender_name,sender_email,smtp_username,smtp_enabled,mailbox_root)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, values.label || values.email, values.email, values.imapHost, values.imapPort, values.imapSecurity, values.smtpEnabled ? (values.smtpHost ?? null) : null, values.smtpEnabled ? (values.smtpPort ?? null) : null, values.smtpEnabled ? (values.smtpSecurity ?? null) : null, values.username, encrypted, values.pollSeconds, now, now, values.senderName, values.senderEmail ?? values.email, values.smtpEnabled ? (values.smtpUsername ?? values.username) : null, values.smtpEnabled ? 1 : 0, values.mailboxRoot ?? null);
      return c.json({ id, label: values.label || values.email, email: values.email, approvalRequired: true }, 201);
    } catch (error) {
      if (error instanceof SQLiteError && [1555, 2067].includes(error.errno)) return c.json({ error: "Mailbox already exists" }, 409);
      const requestId = randomBytes(8).toString("hex");
      console.error(`Mailbox save failed (${requestId}): ${error instanceof SQLiteError ? `SQLite ${error.errno}` : error instanceof Error ? error.name : "unknown error"}`);
      return c.json({ error: "Mailbox could not be saved", requestId }, 500);
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
    return c.json({ mailboxes: db.query("SELECT id,label,email,imap_host AS imapHost,imap_port AS imapPort,imap_security AS imapSecurity,smtp_host AS smtpHost,smtp_port AS smtpPort,smtp_security AS smtpSecurity,smtp_enabled AS smtpEnabled,poll_seconds AS pollSeconds,status FROM mailboxes ORDER BY label").all() });
  });
  app.post("/api/agents", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{ label?: string }>().catch((): { label?: string } => ({}));
    const label = body.label?.trim();
    if (!label || label.length > 80 || /[\r\n\0]/.test(label)) return c.json({ error: "Agent label must be 1 to 80 characters." }, 400);
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?)").run(id, label, createHash("sha256").update(token).digest("hex"), token.slice(0, 8), new Date().toISOString());
    return c.json({ id, label, token }, 201);
  });
  app.get("/api/agents", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ agents: db.query("SELECT id,label,token_prefix AS tokenPrefix,enabled,created_at AS createdAt,last_used_at AS lastUsedAt FROM agents ORDER BY label").all() });
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
    const result = db.query("UPDATE agents SET enabled=0 WHERE id=?").run(agentId);
    if (result.changes === 0) return c.json({ error: "Agent not found." }, 404);
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
  console.error("Usage: postmote [--version|init|serve|doctor|config show|mcp stdio]");
  process.exitCode = 2;
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
:root{font:16px/1.5 system-ui,sans-serif;color:#18212b;background:#f5f7f9}*{box-sizing:border-box}body{margin:0}header{background:#132b3a;color:white;padding:1rem max(1rem,calc((100vw - 960px)/2));display:flex;align-items:center;justify-content:space-between}header h1{font-size:1.25rem;margin:0}main{max-width:960px;margin:2rem auto;padding:0 1rem}.panel{background:white;border:1px solid #d7dee5;border-radius:12px;padding:1.25rem;margin:1rem 0;box-shadow:0 2px 8px #142a3a0b}h2{font-size:1.15rem;margin:.15rem 0 1rem}h3{font-size:1rem;margin:1rem 0 .5rem}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem 1rem}.field{display:flex;flex-direction:column;gap:.25rem}.wide{grid-column:1/-1}label{font-weight:600;font-size:.92rem}input,select,button{font:inherit;border:1px solid #9aa8b5;border-radius:7px;padding:.55rem .65rem;background:white;color:#18212b}input:focus,select:focus,button:focus-visible{outline:3px solid #007e9e;outline-offset:2px}button{cursor:pointer;font-weight:650;background:#075b74;color:white;border-color:#075b74}.secondary{background:white;color:#18212b;border-color:#8797a4}.actions{display:flex;gap:.65rem;align-items:center;flex-wrap:wrap;margin-top:1rem}.status{min-height:1.5rem;color:#8b260f}.muted{color:#4c5e6d}.row{border-top:1px solid #e2e7eb;padding:.7rem 0}.check{display:flex;gap:.6rem;align-items:center}.check input{width:1.1rem;height:1.1rem}.token{padding:.7rem;background:#f1f4f6;border-radius:6px;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:620px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}main{margin:1rem auto}.panel{padding:1rem}}
</style></head><body><header><h1>Postmote</h1><button id="logout" class="secondary" hidden>Sign out</button></header><main>
<section id="setup" class="panel" hidden><h2>Set up owner access</h2><p class="muted">Choose a local password of at least 12 characters. Postmote stores only a password hash.</p><form id="setupForm"><div class="field"><label for="setupPassword">Owner password</label><input id="setupPassword" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div><div class="actions"><button>Initialize</button></div></form><p id="setupStatus" class="status" role="status" aria-live="polite"></p></section>
<section id="login" class="panel" hidden><h2>Sign in</h2><form id="loginForm"><div class="field"><label for="loginPassword">Owner password</label><input id="loginPassword" type="password" autocomplete="current-password" required></div><div class="actions"><button>Sign in</button></div></form><p id="loginStatus" class="status" role="status" aria-live="polite"></p></section>
<div id="app" hidden><section class="panel"><h2>Add mailbox</h2><p class="muted">Credentials are encrypted locally. IMAP/SMTP connection tests, mail sync, and sending are not available yet.</p><form id="mailboxForm"><h3>Identity</h3><div class="grid">
<div class="field"><label for="label">Display label</label><input id="label" maxlength="80" autocomplete="off"></div><div class="field"><label for="email">Email address</label><input id="email" type="email" maxlength="254" autocomplete="email" required></div>
<div class="field"><label for="senderName">Sender name</label><input id="senderName" maxlength="100" autocomplete="off"></div><div class="field"><label for="senderEmail">Sender email</label><input id="senderEmail" type="email" maxlength="254" autocomplete="off"></div></div>
<h3>Incoming mail (IMAP)</h3><div class="grid"><div class="field"><label for="imapHost">IMAP host</label><input id="imapHost" maxlength="253" autocomplete="off" required></div><div class="field"><label for="imapPort">Port</label><input id="imapPort" type="number" min="1" max="65535" value="993" required></div><div class="field"><label for="imapSecurity">Encryption</label><select id="imapSecurity"><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></div><div class="field"><label for="username">Username</label><input id="username" maxlength="320" autocomplete="username" required></div><div class="field"><label for="password">Password or app password</label><input id="password" type="password" maxlength="4096" autocomplete="new-password" required></div><div class="field"><label for="pollSeconds">Polling interval (seconds)</label><input id="pollSeconds" type="number" min="60" max="3600" value="120" required></div><div class="field wide"><label for="mailboxRoot">Mailbox root (optional)</label><input id="mailboxRoot" maxlength="512" autocomplete="off"></div></div>
<h3>Outgoing mail (SMTP)</h3><label class="check"><input id="smtpDisabled" type="checkbox"> Disable sending (read-only mailbox)</label><div id="smtpFields" class="grid" style="margin-top:.8rem"><div class="field"><label for="smtpHost">SMTP host</label><input id="smtpHost" maxlength="253" required></div><div class="field"><label for="smtpPort">Port</label><input id="smtpPort" type="number" min="1" max="65535" value="465" required></div><div class="field"><label for="smtpSecurity">Encryption</label><select id="smtpSecurity"><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></div><div class="field"><label for="smtpUsername">Username</label><input id="smtpUsername" maxlength="320" autocomplete="username" required></div><div class="field"><label for="smtpPassword">Password or app password</label><input id="smtpPassword" type="password" maxlength="4096" autocomplete="new-password" required></div><div class="field"><label class="check"><input id="sameImap" type="checkbox"> Use IMAP username and password</label></div></div>
<h3>Agent access</h3><p class="muted">New mailboxes have no agent access. Set grants after saving.</p><div class="actions"><button id="testImap" class="secondary" type="button">Test IMAP</button><button id="testSmtp" class="secondary" type="button">Test SMTP</button><button>Save mailbox</button></div><p id="testStatus" class="muted" role="status" aria-live="polite"></p></form><p id="mailboxStatus" class="status" role="status" aria-live="polite"></p></section>
<section class="panel"><h2>Mailboxes</h2><div id="mailboxes" aria-live="polite"></div></section>
<section class="panel"><h2>Agents</h2><form id="agentForm"><div class="grid"><div class="field"><label for="agentLabel">Agent name</label><input id="agentLabel" maxlength="80" required></div><div class="field"><label>Mailbox permissions</label><div id="grantChoices" class="muted">Add a mailbox first.</div></div></div><div class="actions"><button>Create agent token</button></div></form><p id="agentStatus" class="status" role="status" aria-live="polite"></p><div id="tokenPanel" hidden><p>Copy this token now. It will not be shown again.</p><p id="agentToken" class="token"></p></div><div id="agents"></div></section></div>
</main><script>
const byId=id=>document.getElementById(id);const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok){let message=data.error||'Request failed';if(data.fields)message+=': '+Object.entries(data.fields).map(([field,errors])=>field+' '+errors.join(', ')).join('; ');throw new Error(message)}return data};const show=(id,on)=>byId(id).hidden=!on;const say=(id,text)=>byId(id).textContent=text;
async function refresh(){const state=await api('/api/auth/me');show('setup',!state.initialized);show('login',state.initialized&&!state.authenticated);show('app',state.authenticated);show('logout',state.authenticated);if(state.authenticated){await loadMailboxes();await loadAgents()}}
byId('setupForm').addEventListener('submit',async e=>{e.preventDefault();say('setupStatus','');try{await api('/api/setup/initialize',{method:'POST',body:JSON.stringify({password:byId('setupPassword').value})});byId('setupPassword').value='';await refresh()}catch(err){say('setupStatus',err.message)}});
byId('loginForm').addEventListener('submit',async e=>{e.preventDefault();say('loginStatus','');try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:byId('loginPassword').value})});byId('loginPassword').value='';await refresh()}catch(err){say('loginStatus',err.message)}});
byId('logout').addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});await refresh()});
byId('smtpSecurity').addEventListener('change',()=>{byId('smtpPort').value=byId('smtpSecurity').value==='tls'?'465':'587'});
byId('smtpDisabled').addEventListener('change',()=>{byId('smtpFields').hidden=byId('smtpDisabled').checked;for(const el of byId('smtpFields').querySelectorAll('input,select'))el.required=!byId('smtpDisabled').checked});
byId('sameImap').addEventListener('change',()=>{byId('smtpUsername').disabled=byId('sameImap').checked;byId('smtpPassword').disabled=byId('sameImap').checked;byId('smtpUsername').required=!byId('sameImap').checked;byId('smtpPassword').required=!byId('sameImap').checked});
let passedImap=null,passedSmtp=null;const mailboxPayload=()=>{const same=byId('sameImap').checked,disabled=byId('smtpDisabled').checked;return {label:byId('label').value,email:byId('email').value,senderName:byId('senderName').value,senderEmail:byId('senderEmail').value||undefined,imapHost:byId('imapHost').value,imapPort:Number(byId('imapPort').value),imapSecurity:byId('imapSecurity').value,username:byId('username').value,password:byId('password').value,mailboxRoot:byId('mailboxRoot').value||undefined,pollSeconds:Number(byId('pollSeconds').value),smtpEnabled:!disabled,smtpHost:disabled?undefined:byId('smtpHost').value,smtpPort:disabled?undefined:Number(byId('smtpPort').value),smtpSecurity:disabled?undefined:byId('smtpSecurity').value,smtpUsername:disabled?undefined:(same?byId('username').value:byId('smtpUsername').value),smtpPassword:disabled?undefined:(same?byId('password').value:byId('smtpPassword').value)}};const fingerprint=()=>JSON.stringify(mailboxPayload());
byId('mailboxForm').addEventListener('input',()=>{passedImap=null;passedSmtp=null;say('testStatus','Form changes clear previous connection test results.')});
async function testMailbox(kind){const button=byId(kind==='imap'?'testImap':'testSmtp');button.disabled=true;say('testStatus','Testing '+kind.toUpperCase()+' connection…');try{const result=await api('/api/mailboxes/test-'+kind,{method:'POST',body:JSON.stringify(mailboxPayload())});if(!result.ok)throw new Error(result.message);if(kind==='imap')passedImap=fingerprint();else passedSmtp=fingerprint();say('testStatus',kind.toUpperCase()+': '+result.message)}catch(err){say('testStatus',kind.toUpperCase()+' test failed: '+err.message)}finally{button.disabled=false}}
byId('testImap').addEventListener('click',()=>testMailbox('imap'));byId('testSmtp').addEventListener('click',()=>testMailbox('smtp'));
byId('mailboxForm').addEventListener('submit',async e=>{e.preventDefault();if((passedImap!==fingerprint()||(!byId('smtpDisabled').checked&&passedSmtp!==fingerprint()))&&!confirm('The current settings have not passed both connection tests. Save them anyway?'))return;say('mailboxStatus','Saving encrypted mailbox credentials…');try{await api('/api/mailboxes',{method:'POST',body:JSON.stringify(mailboxPayload())});e.target.reset();byId('imapPort').value='993';byId('smtpPort').value='465';byId('pollSeconds').value='120';byId('smtpFields').hidden=false;byId('sameImap').dispatchEvent(new Event('change'));passedImap=null;passedSmtp=null;say('testStatus','');say('mailboxStatus','Mailbox saved.');await loadMailboxes()}catch(err){say('mailboxStatus',err.message)}});
async function loadMailboxes(){const data=await api('/api/mailboxes');const list=byId('mailboxes');list.replaceChildren();const choices=byId('grantChoices');choices.replaceChildren();if(!data.mailboxes.length){list.textContent='No mailboxes configured.';choices.textContent='Add a mailbox first.';return}const capabilities=['mail.read','mail.search','mail.draft','mail.reply','mail.forward','mail.send.request','mail.modify','mail.delete','mail.attachments'];for(const box of data.mailboxes){const row=document.createElement('div');row.className='row';row.textContent=box.label+' · '+box.email+' · IMAP '+box.imapSecurity.toUpperCase()+' · '+(box.smtpEnabled?'SMTP enabled':'read only');list.append(row);const group=document.createElement('fieldset');group.className='row';const legend=document.createElement('legend');legend.textContent=box.label+' ('+box.email+')';group.append(legend);for(const capability of capabilities){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=capability;input.dataset.mailboxId=box.id;label.append(input,document.createTextNode(capability));group.append(label)}choices.append(group)}}
byId('agentForm').addEventListener('submit',async e=>{e.preventDefault();say('agentStatus','');show('tokenPanel',false);try{const agent=await api('/api/agents',{method:'POST',body:JSON.stringify({label:byId('agentLabel').value})});say('agentToken',agent.token);show('tokenPanel',true);const grants=[...document.querySelectorAll('#grantChoices input:checked')].reduce((all,input)=>{let grant=all.find(item=>item.mailboxId===input.dataset.mailboxId);if(!grant){grant={mailboxId:input.dataset.mailboxId,capabilities:[]};all.push(grant)}grant.capabilities.push(input.value);return all},[]);if(grants.length)await api('/api/agents/'+agent.id+'/grants',{method:'PUT',body:JSON.stringify({grants})});byId('agentLabel').value='';await loadAgents()}catch(err){say('agentStatus',err.message)}});
async function loadAgents(){const data=await api('/api/agents');const list=byId('agents');list.replaceChildren();for(const agent of data.agents){const row=document.createElement('div');row.className='row';const title=document.createElement('span');title.textContent=agent.label+' · token '+agent.tokenPrefix+'… · '+(agent.enabled?'enabled':'revoked');row.append(title);if(agent.enabled){const rotate=document.createElement('button');rotate.type='button';rotate.className='secondary';rotate.textContent='Rotate token';rotate.addEventListener('click',async()=>{try{const result=await api('/api/agents/'+agent.id+'/rotate-token',{method:'POST'});say('agentToken',result.token);show('tokenPanel',true);await loadAgents()}catch(err){say('agentStatus',err.message)}});const revoke=document.createElement('button');revoke.type='button';revoke.className='secondary';revoke.textContent='Revoke';revoke.addEventListener('click',async()=>{if(!confirm('Revoke this agent token?'))return;try{await api('/api/agents/'+agent.id,{method:'DELETE'});await loadAgents()}catch(err){say('agentStatus',err.message)}});row.append(document.createTextNode(' '),rotate,document.createTextNode(' '),revoke)}list.append(row)}}
refresh().catch(err=>console.error('Postmote startup failed',err));
</script></body></html>`;
}
