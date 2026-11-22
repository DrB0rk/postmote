import { createHmac, timingSafeEqual } from "node:crypto";

export type SearchCursor = { agentId: string; mailboxId: string; folder: string; filter: string; uidValidity: number; beforeUid: number; expiresAt: number };

export function encodeCursor(key: Buffer, cursor: SearchCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function decodeCursor(key: Buffer, value: string): SearchCursor | null {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || value.length > 2048) return null;
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as SearchCursor;
    if (typeof c.agentId !== "string" || typeof c.mailboxId !== "string" || typeof c.folder !== "string" || typeof c.filter !== "string" || !Number.isSafeInteger(c.uidValidity) || c.uidValidity < 1 || !Number.isSafeInteger(c.beforeUid) || c.beforeUid < 1 || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= Date.now()) return null;
    return c;
  } catch { return null; }
}
