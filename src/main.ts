import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { mailboxInputSchema } from "./mailbox.ts";
import { encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "./vault.ts";
import { authenticateAgentToken, createAgentMcpHandler } from "./mcp.ts";

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
  const db = await openDatabase(config.dataDir);
  const app = new Hono();
  const mcpHandler = createAgentMcpHandler(db);
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return c.text("Invalid host", 400);
    const origin = c.req.header("origin");
    if (origin && origin !== `http://127.0.0.1:${config.port}` && origin !== `http://localhost:${config.port}`) return c.text("Invalid origin", 403);
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));
  app.post("/api/setup/initialize", async (c) => {
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
    const body = await c.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    const row = db.query("SELECT password_hash FROM owner_credentials WHERE id=1").get() as { password_hash: string } | null;
    if (!row || !body.password || !(await verifyOwnerPassword(body.password, row.password_hash))) return c.json({ error: "Invalid credentials" }, 401);
    const session = randomBytes(32).toString("base64url");
    const idHash = createHash("sha256").update(session).digest("hex");
    db.query("INSERT INTO owner_sessions(id_hash,issued_at,expires_at) VALUES(?,?,?)").run(idHash, new Date().toISOString(), new Date(Date.now() + 12 * 3600_000).toISOString());
    c.header("Set-Cookie", `postmote_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return c.json({ authenticated: true });
  });
  app.post("/api/mailboxes", async (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    const input = await c.req.json().catch(() => null);
    const parsed = mailboxInputSchema.safeParse(input);
    if (!parsed.success) return c.json({ error: "Invalid mailbox", fields: parsed.error.flatten().fieldErrors }, 400);
    const values = parsed.data;
    const id = randomBytes(16).toString("hex");
    const encrypted = await encryptSecret(config.dataDir, id, values.password);
    const now = new Date().toISOString();
    try {
      db.query(`INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,encrypted_secret,poll_seconds,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, values.label || values.email, values.email, values.imapHost, values.imapPort, values.imapSecurity, values.smtpHost ?? null, values.smtpPort ?? null, values.smtpSecurity ?? null, values.username, encrypted, values.pollSeconds, now, now);
      return c.json({ id, label: values.label || values.email, email: values.email, approvalRequired: true }, 201);
    } catch {
      return c.json({ error: "Mailbox already exists or could not be saved" }, 409);
    }
  });
  app.get("/api/mailboxes", (c) => {
    if (!isOwnerAuthorized(c.req.header("cookie"), db)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ mailboxes: db.query("SELECT id,label,email,imap_host AS imapHost,imap_port AS imapPort,imap_security AS imapSecurity,smtp_host AS smtpHost,smtp_port AS smtpPort,smtp_security AS smtpSecurity,poll_seconds AS pollSeconds,status FROM mailboxes ORDER BY label").all() });
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
    try { apply(); } catch { return c.json({ error: "Unknown mailbox or invalid grants." }, 400); }
    return c.json({ saved: true });
  });
  app.all("/mcp", async (c) => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const authInfo = bearer ? authenticateAgentToken(db, bearer) : null;
    if (!authInfo) return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    return mcpHandler.fetch(c.req.raw, { authInfo });
  });
  app.get("/", (c) => c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postmote</title><style>body{font:16px system-ui;max-width:760px;margin:4rem auto;padding:0 1rem;color:#17202a}main{border:1px solid #d9e0e7;border-radius:12px;padding:2rem}code{background:#f2f4f7;padding:.2rem .4rem;border-radius:4px}</style><main><h1>Postmote</h1><p>The local mailbox bridge is running.</p><p>Owner setup and mailbox management UI are not included in this initial implementation.</p><p>API health: <code>/api/health</code></p></main></html>`));
  Bun.serve({ hostname: config.bind, port: config.port, fetch: app.fetch });
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
