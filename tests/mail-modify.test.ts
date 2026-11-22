import { expect, test } from "bun:test";
import type { ImapFlow } from "imapflow";
import { MoveUnavailable, TrashUnavailable, isTrashFolder, moveMessage, trashMessage, updateFlags, permanentlyDelete } from "../src/mail/modify.ts";
import { MessageUnavailable, StaleMessageReference } from "../src/mail/read.ts";

const ref={ mailboxId:"box",folder:"INBOX",uidValidity:42,uid:7 };
function mockClient(options:{capabilities?:string[];validity?:bigint;missing?:boolean;trash?:boolean}={}) {
  let moved=0, released=0;
  const client={
    mailbox:{uidValidity:options.validity ?? 42n},
    capabilities:new Map((options.capabilities ?? []).map(capability=>[capability,true])),
    getMailboxLock:async () => ({release:()=>released++}),
    fetchOne:async () => options.missing ? false : {uid:7,flags:new Set(["\\Seen"])},
    messageFlagsAdd:async () => true,
    messageFlagsRemove:async () => true,
    messageDelete:async () => true,
    messageMove:async () => { moved++; return { destination:"Archive",uidValidity:44n,uidMap:new Map([[7,8]]) }; },
    list:async () => options.trash ? [{path:"Trash",specialUse:"\\Trash",flags:new Set(["\\Trash"])}] : [],
  };
  return {client:client as unknown as ImapFlow,moved:()=>moved,released:()=>released};
}

test("flags check message identity before modifying it", async () => {
  const valid=mockClient();
  expect(await updateFlags(valid.client,ref,"add",["\\Seen"])).toEqual(["\\Seen"]);
  expect(valid.released()).toBe(1);
  const stale=mockClient({validity:43n});
  await expect(updateFlags(stale.client,ref,"add",["\\Seen"])).rejects.toBeInstanceOf(StaleMessageReference);
  expect(stale.released()).toBe(1);
  const missing=mockClient({missing:true});
  await expect(updateFlags(missing.client,ref,"add",["\\Seen"])).rejects.toBeInstanceOf(MessageUnavailable);
});

test("moves never fall back to an untargeted expunge", async () => {
  expect(isTrashFolder({flags:new Set(["\\trash"])})).toBe(true);
  const unsafe=mockClient();
  await expect(moveMessage(unsafe.client,ref,"Archive")).rejects.toBeInstanceOf(MoveUnavailable);
  expect(unsafe.moved()).toBe(0);
  await expect(permanentlyDelete(unsafe.client,ref)).rejects.toBeInstanceOf(MoveUnavailable);
  const safe=mockClient({capabilities:["UIDPLUS"]});
  expect(await moveMessage(safe.client,ref,"Archive")).toEqual({mailboxId:"box",folder:"Archive",uidValidity:44,uid:8});
  await expect(permanentlyDelete(safe.client,ref)).resolves.toBeUndefined();
  const noTrash=mockClient({capabilities:["MOVE"]});
  await expect(trashMessage(noTrash.client,ref)).rejects.toBeInstanceOf(TrashUnavailable);
});
