import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { mailboxInputSchema } from "../src/mailbox.ts";
import { decryptSecret, encryptSecret, ensureMasterKey, hashOwnerPassword, verifyOwnerPassword } from "../src/vault.ts";

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
