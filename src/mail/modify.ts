import type { ImapFlow } from "imapflow";
import { MessageUnavailable, StaleMessageReference } from "./read.ts";

export type MessageRef = { mailboxId:string; folder:string; uidValidity:number; uid:number };
export class MoveUnavailable extends Error {}
export class TrashUnavailable extends Error {}

export function isTrashFolder(folder:{specialUse?:string; flags:Set<string>}):boolean {
  return folder.specialUse?.toLowerCase() === "\\trash" || [...folder.flags].some(flag => flag.toLowerCase() === "\\trash");
}

async function withMessage<T>(client: ImapFlow, message: MessageRef, run: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(message.folder);
  try {
    if (!client.mailbox || client.mailbox.uidValidity !== BigInt(message.uidValidity)) throw new StaleMessageReference();
    if (!await client.fetchOne(String(message.uid), { uid:true }, { uid:true })) throw new MessageUnavailable();
    return await run();
  } finally { lock.release(); }
}

export async function updateFlags(client: ImapFlow, message: MessageRef, operation: "add" | "remove", flags: string[]) {
  return withMessage(client,message,async () => {
    const updated = operation === "add" ? await client.messageFlagsAdd(String(message.uid),flags,{uid:true}) : await client.messageFlagsRemove(String(message.uid),flags,{uid:true});
    if (!updated) throw new Error("IMAP flag update failed");
    const current = await client.fetchOne(String(message.uid),{uid:true,flags:true},{uid:true});
    if (!current) throw new MessageUnavailable();
    return [...(current.flags ?? [])];
  });
}

export async function moveMessage(client: ImapFlow, message: MessageRef, destination: string) {
  return withMessage(client,message,async () => {
    // ImapFlow falls back to COPY + EXPUNGE, which can expunge unrelated messages without UIDPLUS.
    if (!client.capabilities.has("MOVE") && !client.capabilities.has("UIDPLUS")) throw new MoveUnavailable();
    if (destination === message.folder) throw new MoveUnavailable();
    const moved = await client.messageMove(String(message.uid),destination,{uid:true});
    if (!moved) throw new Error("IMAP move failed");
    const uid=moved.uidMap?.get(message.uid), uidValidity=moved.uidValidity === undefined ? undefined : Number(moved.uidValidity);
    return uid && uidValidity && Number.isSafeInteger(uidValidity) ? { mailboxId:message.mailboxId, folder:moved.destination, uidValidity, uid } : null;
  });
}

export async function trashMessage(client: ImapFlow, message: MessageRef) {
  const folders=await client.list();
  const trash=folders.find(isTrashFolder);
  if (!trash || trash.path === message.folder) throw new TrashUnavailable();
  return moveMessage(client,message,trash.path);
}

export async function permanentlyDelete(client: ImapFlow, message: MessageRef) {
  return withMessage(client,message,async () => {
    // A plain EXPUNGE can remove unrelated messages; only UID EXPUNGE is safe here.
    if (!client.capabilities.has("UIDPLUS")) throw new MoveUnavailable();
    if (!await client.messageDelete(String(message.uid),{uid:true})) throw new Error("IMAP deletion failed");
  });
}
