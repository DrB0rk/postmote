import type { ImapFlow } from "imapflow";

export class StaleMessageReference extends Error {}
export class MessageUnavailable extends Error {}
export class MessageTooLarge extends Error {}

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MIME_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type Reader = Pick<ImapFlow, "mailbox" | "getMailboxLock" | "fetchOne" | "download">;

/** Retrieve a message only if its folder still has the UIDVALIDITY reported when it was listed. */
export async function readMessage(client: Reader, folder: string, uidValidity: number, uid: number, maxBytes = MAX_MESSAGE_BYTES) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    if (!client.mailbox || client.mailbox.uidValidity !== BigInt(uidValidity)) throw new StaleMessageReference();
    const message = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
    if (!message) throw new MessageUnavailable();
    if (message.size === undefined || message.size > maxBytes) throw new MessageTooLarge();
    const download = await client.download(String(uid), undefined, { uid: true, maxBytes: maxBytes + 1 });
    if (!download.content) throw new MessageUnavailable();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of download.content) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > maxBytes) throw new MessageTooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { lock.release(); }
}
