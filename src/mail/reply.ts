import type { AddressObject, ParsedMail } from "mailparser";

export class CannotPrepareMessage extends Error {}
export class ForwardAttachmentsUnsupported extends Error {}

function list(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap(item => item.value.flatMap(address => address.group ? address.group.map(member => member.address ?? "") : [address.address ?? ""])).filter(Boolean);
}
function unique(values:string[]) { const seen=new Set<string>(); return values.filter(value => { const key=value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); }
function prefix(subject:string | undefined, prefix:string) {
  const normalized=(subject ?? "").replace(/[\r\n\0]/g," ");
  const value=new RegExp(`^${prefix}:`,"i").test(normalized) ? normalized : `${prefix}: ${normalized}`;
  let result=""; for (const char of value) { if (Buffer.byteLength(result+char,"utf8")>998) break; result+=char; } return result;
}
function messageId(value:unknown): string | undefined { return typeof value === "string" && value.length <= 998 && /^<[^<>\s\x00-\x1f]+>$/.test(value) ? value : undefined; }

export function prepareReply(parsed:ParsedMail, ownAddresses:string[], replyAll:boolean, text:string) {
  const primary=unique(list(parsed.replyTo).length ? list(parsed.replyTo) : list(parsed.from));
  if (!primary.length) throw new CannotPrepareMessage();
  const own=new Set(ownAddresses.map(value => value.toLowerCase()));
  const others=replyAll ? unique([...list(parsed.to),...list(parsed.cc)]).filter(value => !own.has(value.toLowerCase()) && !primary.some(p => p.toLowerCase()===value.toLowerCase())) : [];
  const id=messageId(parsed.messageId);
  const refs=(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).map(messageId).filter((value): value is string => !!value).slice(-19);
  if (id && !refs.includes(id)) refs.push(id);
  return { to:primary,cc:others,bcc:[],subject:prefix(parsed.subject,"Re"),text,inReplyTo:id,references:refs };
}

export function prepareForward(parsed:ParsedMail, to:string[], text:string) {
  if (parsed.attachments.length) throw new ForwardAttachmentsUnsupported();
  if (parsed.text === undefined) throw new CannotPrepareMessage();
  const from=list(parsed.from).join(", ");
  const original=["--- Forwarded message ---", `From: ${from}`, `Subject: ${(parsed.subject ?? "").replace(/[\r\n\0]/g," ")}`, "", parsed.text ?? ""].join("\n");
  const body=[text,original].filter(Boolean).join("\n\n");
  if (body.length>100000) throw new CannotPrepareMessage();
  return {to,cc:[],bcc:[],subject:prefix(parsed.subject,"Fwd"),text:body};
}
