import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { mailboxInputSchema } from "../src/mailbox.ts";
import { decryptSecret, encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "../src/vault.ts";
import { authenticateAgentToken, createAgentMcpHandler } from "../src/mcp.ts";
import { acquireDaemonLock } from "../src/daemon-lock.ts";
import { testImapConnection, testSmtpConnection } from "../src/mail/connections.ts";

describe("configuration", () => {
  test("rejects non-loopback bind addresses", () => {
    expect(() => loadConfig({ POSTMOTE_BIND: "0.0.0.0" })).toThrow();
  });

  test("enforces a minimum poll interval", () => {
    expect(() => loadConfig({ POSTMOTE_DEFAULT_POLL_SECONDS: "30" })).toThrow();
  });

  test("keeps data outside the working directory and expands a home-relative override", () => {
    expect(() => loadConfig({ POSTMOTE_DATA_DIR: "relative-data" })).toThrow();
    expect(loadConfig({ POSTMOTE_DATA_DIR: "~/postmote-data" }).dataDir).toBe(join(homedir(), "postmote-data"));
  });
});

describe("mailbox validation", () => {
  const valid = { email: "owner@example.test", imapHost: "mail.example.test", username: "owner", password: "secret", smtpEnabled: false };

  test("requires secure transport values and valid ports", () => {
    expect(mailboxInputSchema.safeParse(valid).success).toBe(true);
    expect(mailboxInputSchema.safeParse({ ...valid, imapPort: 65536 }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, imapHost: "https://mail.example.test" }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, imapSecurity: "none" }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, imapHost: "2001:db8::1" }).success).toBe(true);
    expect(mailboxInputSchema.safeParse({ ...valid, smtpEnabled: true }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, smtpEnabled: true, smtpHost: "smtp.example.test", smtpPort: 465, smtpSecurity: "tls", smtpUsername: "owner", smtpPassword: "secret" }).success).toBe(true);
  });
});

describe("local persistence and vault", () => {
  test("encrypts mailbox secrets with mailbox-bound authenticated data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-test-"));
    try {
      if (process.platform !== "win32") await chmod(dir, 0o777);
      await ensureMasterKey(dir);
      if (process.platform !== "win32") {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, "master.key"))).mode & 0o777).toBe(0o600);
      }
      const cipher = await encryptSecret(dir, "mailbox-a", "p@ss word");
      expect(cipher).not.toContain("p@ss word");
      expect(await decryptSecret(dir, "mailbox-a", cipher)).toBe("p@ss word");
      await expect(decryptSecret(dir, "mailbox-b", cipher)).rejects.toThrow();
      const key = await readFile(join(dir, "master.key"));
      expect(key).toHaveLength(32);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("stores only a password hash and creates the SQLite schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-test-"));
    try {
      const hash = await hashOwnerPassword("long enough test password");
      expect(hash).not.toContain("long enough test password");
      expect(await verifyOwnerPassword("long enough test password", hash)).toBe(true);
      expect(await verifyOwnerPassword("wrong password", hash)).toBe(false);
      const db = await openDatabase(dir);
      expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 2 });
      if (process.platform !== "win32") expect((await stat(join(dir, "postmote.db"))).mode & 0o777).toBe(0o600);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("preserves read-only SMTP state when upgrading legacy mailboxes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-migration-test-"));
    try {
      const legacy = new Database(join(dir, "postmote.db"));
      legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES(1, '2025-01-01');
        CREATE TABLE mailboxes (
          id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL,
          imap_security TEXT NOT NULL, smtp_host TEXT, smtp_port INTEGER, smtp_security TEXT, username TEXT NOT NULL,
          encrypted_secret TEXT NOT NULL, auth_kind TEXT NOT NULL DEFAULT 'password', poll_seconds INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(email, imap_host));
        INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at)
          VALUES('read','Read','read@example.test','imap.example.test',993,'tls','read','cipher',120,'now','now');
        INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,encrypted_secret,poll_seconds,created_at,updated_at)
          VALUES('send','Send','send@example.test','imap.example.test',993,'tls','smtp.example.test',465,'tls','send','cipher',120,'now','now');`);
      legacy.close();
      const db = await openDatabase(dir);
      expect(db.query("SELECT id,smtp_enabled FROM mailboxes ORDER BY id").all()).toEqual([
        { id: "read", smtp_enabled: 0 }, { id: "send", smtp_enabled: 1 },
      ]);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("daemon ownership", () => {
  test("allows one daemon and recovers a stale lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-lock-test-"));
    try {
      const release = await acquireDaemonLock(dir);
      await expect(acquireDaemonLock(dir)).rejects.toThrow("already running");
      await release();
      await writeFile(join(dir, "daemon.lock"), JSON.stringify({ pid: 99999999, identity: "stale" }) + "\n", { mode: 0o600 });
      const releaseAfterStaleLock = await acquireDaemonLock(dir);
      await releaseAfterStaleLock();
      await expect(readFile(join(dir, "daemon.lock"))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("mail transport checks", () => {
  test("reports a refused local connection without exposing credentials", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const results = await Promise.all([
      testImapConnection({ host: "127.0.0.1", port: address.port, security: "tls", username: "test-user", password: "never-return-this" }),
      testSmtpConnection({ host: "127.0.0.1", port: address.port, security: "tls", username: "test-user", password: "never-return-this" }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("never-return-this");
      expect(result.message).not.toContain("test-user");
    }
  }, 15000);
});

describe("agent authorization and MCP", () => {
  test("authenticates scoped agent tokens and keeps MCP listing within grants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-test-"));
    try {
      const db = await openDatabase(dir);
      const token = "a".repeat(64);
      const now = new Date().toISOString();
      db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?)").run("agent-a", "Agent A", createHash("sha256").update(token).digest("hex"), token.slice(0, 8), now);
      db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?)").run("agent-b", "Agent B", createHash("sha256").update("b".repeat(64)).digest("hex"), "bbbbbbbb", now);
      db.query(`INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at)
        VALUES('box-a','Account A','a@example.test','mail.example.test',993,'tls','a','cipher',120,?,?)`).run(now, now);
      db.query("INSERT INTO agent_mailbox_grants(agent_id,mailbox_id,capability,created_at) VALUES('agent-a','box-a','mail.read',?)").run(now);

      const authInfo = authenticateAgentToken(db, token);
      expect(authInfo?.clientId).toBe("agent-a");
      expect(authenticateAgentToken(db, `${token}x`)).toBeNull();
      const handler = createAgentMcpHandler(db);
      const response = await handler.fetch(new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_accounts", arguments: {} } }),
      }), { authInfo: authInfo! });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("Account A");
      expect(body).toContain("a@example.test");
      expect(body).not.toContain("cipher");
      const deniedResponse = await handler.fetch(new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mail_status", arguments: { mailboxId: "box-a" } } }),
      }), { authInfo: { token: "b".repeat(64), clientId: "agent-b", scopes: [] } });
      expect(await deniedResponse.text()).toContain("FORBIDDEN");
      await handler.close();
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("owner and HTTP integration", () => {
  test("initializes, saves a mailbox, grants an agent, and serves MCP over loopback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-http-test-"));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const child = Bun.spawn([process.execPath, "src/main.ts", "serve"], {
      env: { ...process.env, POSTMOTE_DATA_DIR: dir, POSTMOTE_PORT: String(port) },
      stdout: "ignore",
      stderr: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    const request = async (path: string, options: RequestInit = {}) => {
      const response = await fetch(base + path, options);
      const body = await response.json() as Record<string, unknown>;
      return { response, body };
    };
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(base + "/api/health")).ok) { healthy = true; break; }
        } catch { await Bun.sleep(50); }
      }
      expect(healthy).toBe(true);
      const dashboard = await fetch(base + "/");
      const dashboardHtml = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(dashboardHtml).toContain("Set up owner access");
      expect(dashboardHtml).toContain("Test IMAP");
      expect(dashboard.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const setup = await request("/api/setup/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "local integration password" }) });
      expect(setup.response.status).toBe(201);
      const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "local integration password" }) });
      const cookie = login.response.headers.get("set-cookie");
      expect(cookie).toContain("postmote_session=");
      const headers = { cookie: cookie!, "content-type": "application/json" };
      const mailbox = await request("/api/mailboxes", { method: "POST", headers, body: JSON.stringify({ email: "test@example.test", imapHost: "mail.example.test", username: "test-user", password: "imap-test-secret", smtpEnabled: false }) });
      expect(mailbox.response.status).toBe(201);
      const agent = await request("/api/agents", { method: "POST", headers, body: JSON.stringify({ label: "Integration agent" }) });
      expect(agent.response.status).toBe(201);
      const agentData = agent.body as { id: string; token: string };
      await request(`/api/agents/${agentData.id}/grants`, { method: "PUT", headers, body: JSON.stringify({ grants: [{ mailboxId: mailbox.body.id, capabilities: ["mail.read"] }] }) });
      const mcp = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${agentData.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_accounts", arguments: {} } }) });
      const result = await mcp.text();
      expect(mcp.status).toBe(200);
      expect(result).toContain("test@example.test");
      expect(result).not.toContain("imap-test-secret");
      const grants = await request(`/api/agents/${agentData.id}/grants`, { headers: { cookie: cookie! } });
      expect(grants.body.grants).toEqual([{ mailboxId: mailbox.body.id, capability: "mail.read" }]);
      const rotation = await request(`/api/agents/${agentData.id}/rotate-token`, { method: "POST", headers: { cookie: cookie! } });
      expect(typeof rotation.body.token).toBe("string");
      const oldToken = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${agentData.token}`, "content-type": "application/json" }, body: "{}" });
      expect(oldToken.status).toBe(401);
      const revoke = await request(`/api/agents/${agentData.id}`, { method: "DELETE", headers: { cookie: cookie! } });
      expect(revoke.body.revoked).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
