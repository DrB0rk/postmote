import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decodeCursor, encodeCursor } from "../src/mail/cursor.ts";

describe("search cursors", () => {
  test("authenticates cursor contents and rejects tampering, wrong keys, and expiration", () => {
    const key = randomBytes(32);
    const item = { agentId: "agent", mailboxId: "box", folder: "INBOX", filter: "{}", uidValidity: 42, beforeUid: 10, expiresAt: Date.now() + 60000 };
    const encoded = encodeCursor(key, item);
    expect(decodeCursor(key, encoded)).toEqual(item);
    expect(decodeCursor(randomBytes(32), encoded)).toBeNull();
    const [payload, signature] = encoded.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...item, mailboxId: "other" })).toString("base64url");
    expect(decodeCursor(key, `${tampered}.${signature}`)).toBeNull();
    expect(decodeCursor(key, encodeCursor(key, { ...item, expiresAt: Date.now() - 1 }))).toBeNull();
    expect(decodeCursor(key, payload!)).toBeNull();
  });
});
