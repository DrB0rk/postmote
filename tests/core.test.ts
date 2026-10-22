import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { mailboxInputSchema } from "../src/mailbox.ts";
import { decryptSecret, encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "../src/vault.ts";
import { authenticateAgentToken, createAgentMcpHandler } from "../src/mcp.ts";

describe("configuration", () => {
  test("rejects non-loopback bind addresses", () => {
    expect(() => loadConfig({ POSTMOTE_BIND: "0.0.0.0" })).toThrow();
  });

  test("enforces a minimum poll interval", () => {
    expect(() => loadConfig({ POSTMOTE_DEFAULT_POLL_SECONDS: "30" })).toThrow();
  });
});

describe("mailbox validation", () => {
  const valid = { email: "owner@example.test", imapHost: "mail.example.test", username: "owner", password: "secret" };

  test("requires secure transport values and valid ports", () => {
    expect(mailboxInputSchema.safeParse(valid).success).toBe(true);
    expect(mailboxInputSchema.safeParse({ ...valid, imapPort: 65536 }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, imapHost: "https://mail.example.test" }).success).toBe(false);
    expect(mailboxInputSchema.safeParse({ ...valid, imapSecurity: "none" }).success).toBe(false);
  });
});

describe("local persistence and vault", () => {
  test("encrypts mailbox secrets with mailbox-bound authenticated data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-test-"));
    try {
      await ensureMasterKey(dir);
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
      expect(db.query("SELECT version FROM schema_migrations").get()).toEqual({ version: 1 });
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
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
