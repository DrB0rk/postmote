import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { MAX_MESSAGE_BYTES, MessageTooLarge, MessageUnavailable, StaleMessageReference, readMessage } from "../src/mail/read.ts";

function fakeReader(options: { validity?: bigint; size?: number; body?: Buffer; missing?: boolean } = {}) {
  let releases = 0;
  let downloads = 0;
  const client = {
    mailbox: { uidValidity: options.validity ?? 42n },
    getMailboxLock: async (_folder: string, settings: { readOnly: boolean }) => {
      expect(settings.readOnly).toBe(true);
      return { release: () => { releases++; } };
    },
    fetchOne: async () => options.missing ? false : { uid: 7, size: options.size ?? 4 },
    download: async (_uid: string, _part: undefined, settings: { uid: boolean; maxBytes: number }) => {
      downloads++;
      expect(settings).toEqual({ uid: true, maxBytes: MAX_MESSAGE_BYTES + 1 });
      return { content: Readable.from([options.body ?? Buffer.from("test")]) };
    },
  };
  return { client: client as unknown as Parameters<typeof readMessage>[0], releases: () => releases, downloads: () => downloads };
}

describe("IMAP message identity and limits", () => {
  test("reads a bounded message from the requested folder generation", async () => {
    const fake = fakeReader();
    expect((await readMessage(fake.client, "INBOX", 42, 7)).toString()).toBe("test");
    expect(fake.releases()).toBe(1);
  });
  test("rejects stale UIDVALIDITY before fetching message content", async () => {
    const fake = fakeReader();
    await expect(readMessage(fake.client, "INBOX", 41, 7)).rejects.toBeInstanceOf(StaleMessageReference);
    expect(fake.downloads()).toBe(0);
    expect(fake.releases()).toBe(1);
  });
  test("rejects a missing message and advertised or actual oversized content", async () => {
    const missing = fakeReader({ missing: true });
    await expect(readMessage(missing.client, "INBOX", 42, 7)).rejects.toBeInstanceOf(MessageUnavailable);
    const oversized = fakeReader({ size: MAX_MESSAGE_BYTES + 1 });
    await expect(readMessage(oversized.client, "INBOX", 42, 7)).rejects.toBeInstanceOf(MessageTooLarge);
    expect(oversized.downloads()).toBe(0);
    const dishonest = fakeReader({ body: Buffer.alloc(MAX_MESSAGE_BYTES + 1) });
    await expect(readMessage(dishonest.client, "INBOX", 42, 7)).rejects.toBeInstanceOf(MessageTooLarge);
    expect(dishonest.releases()).toBe(1);
  });
});
