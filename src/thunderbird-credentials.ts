import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export class ThunderbirdCredentialError extends Error {
  constructor(public readonly reason:"unsupported"|"locked"|"missing"|"ambiguous"|"invalid") { super(reason); }
}
type SavedLogin = {hostname?:unknown;encryptedUsername?:unknown;encryptedPassword?:unknown};
type Account = { imapHost:string; imapPort:number; username:string; smtpHost:string; smtpPort:number; smtpUsername:string; imapAuthMethod:string|number|boolean|null; smtpAuthMethod:string|number|boolean|null };

function libraryPath() {
  if (process.platform === "linux") return "libnss3.so";
  if (process.platform === "darwin") return "/Applications/Thunderbird.app/Contents/MacOS/libnss3.dylib";
  if (process.platform === "win32" && process.env.ProgramFiles) return join(process.env.ProgramFiles,"Mozilla Thunderbird","nss3.dll");
  throw new ThunderbirdCredentialError("unsupported");
}
function matchesHost(origin:string, scheme:string, host:string, port:number) {
  try { const url=new URL(origin); return url.protocol===`${scheme}:` && url.hostname.toLowerCase()===host.toLowerCase() && (!url.port || Number(url.port)===port) && !url.username && !url.password; } catch { return false; }
}
export function findPasswords(logins:SavedLogin[], account:Account, decrypt:(value:string)=>string | null) {
  const lookup=(scheme:string,host:string,port:number,username:string) => {
    const found=new Set<string>();
    for (const login of logins) {
      if (typeof login.hostname!=="string" || !matchesHost(login.hostname,scheme,host,port) || typeof login.encryptedUsername!=="string" || typeof login.encryptedPassword!=="string") continue;
      if (decrypt(login.encryptedUsername)!==username) continue;
      const password=decrypt(login.encryptedPassword);
      if (password) found.add(password);
    }
    if (!found.size) throw new ThunderbirdCredentialError("missing");
    if (found.size>1) throw new ThunderbirdCredentialError("ambiguous");
    return [...found][0]!;
  };
  return {imapPassword:lookup("imap",account.imapHost,account.imapPort,account.username),smtpPassword:lookup("smtp",account.smtpHost,account.smtpPort,account.smtpUsername)};
}

/** Unlock Thunderbird's NSS store in read-only mode; passwords never leave this process. */
export async function readThunderbirdCredentials(profile:string, account:Account, primaryPassword:string) {
  if ((account.imapAuthMethod!==null && account.imapAuthMethod!==3) || (account.smtpAuthMethod!==null && account.smtpAuthMethod!==3)) throw new ThunderbirdCredentialError("unsupported");
  const path=join(profile,"logins.json");
  if ((await stat(path)).size>8*1024*1024) throw new ThunderbirdCredentialError("invalid");
  const data=JSON.parse(await readFile(path,"utf8")) as {logins?:unknown};
  if (!Array.isArray(data.logins) || data.logins.length>5000) throw new ThunderbirdCredentialError("invalid");
  if (process.arch!=="x64" && process.arch!=="arm64") throw new ThunderbirdCredentialError("unsupported");
  let lib: ReturnType<typeof openNss>;
  try { lib=openNss(libraryPath()); } catch { throw new ThunderbirdCredentialError("unsupported"); }
  let initialized=false, slot:ReturnType<typeof lib.symbols.PK11_GetInternalKeySlot>=null;
  const passwordBytes=Buffer.from(primaryPassword+"\0");
  try {
    if (lib.symbols.NSS_IsInitialized() || lib.symbols.NSS_Init(Buffer.from(`sql:${profile}\0`))!==0) throw new ThunderbirdCredentialError("unsupported");
    initialized=true; slot=lib.symbols.PK11_GetInternalKeySlot();
    if (!slot || lib.symbols.PK11_CheckUserPassword(slot,passwordBytes)!==0) throw new ThunderbirdCredentialError("locked");
    const decrypt=(encoded:string) => {
      const raw=Buffer.from(encoded,"base64"); if (!raw.length || raw.length>16384) return null;
      const source=Buffer.alloc(24), output=Buffer.alloc(24);
      source.writeBigUInt64LE(BigInt(ptr(raw)),8); source.writeUInt32LE(raw.length,16);
      if (lib.symbols.PK11SDR_Decrypt(source,output,null)!==0) return null;
      try {
        const address=output.readBigUInt64LE(8), length=output.readUInt32LE(16);
        if (!address || length>16384) return null;
        return Buffer.from(toArrayBuffer(address,0,length)).toString("utf8");
      } finally { lib.symbols.SECITEM_ZfreeItem(output,0); }
    };
    return findPasswords(data.logins as SavedLogin[],account,decrypt);
  } finally {
    passwordBytes.fill(0);
    if (slot) lib.symbols.PK11_FreeSlot(slot);
    if (initialized) lib.symbols.NSS_Shutdown();
    lib.close();
  }
}
function openNss(path:string) {
  return dlopen(path,{
    NSS_IsInitialized:{args:[],returns:"i32"}, NSS_Init:{args:["cstring"],returns:"i32"}, NSS_Shutdown:{args:[],returns:"i32"},
    PK11_GetInternalKeySlot:{args:[],returns:"ptr"}, PK11_CheckUserPassword:{args:["ptr","cstring"],returns:"i32"}, PK11_FreeSlot:{args:["ptr"],returns:"void"},
    PK11SDR_Decrypt:{args:["ptr","ptr","ptr"],returns:"i32"}, SECITEM_ZfreeItem:{args:["ptr","i32"],returns:"void"},
  });
}
