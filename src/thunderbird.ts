import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function parsePreferences(text: string): Map<string, string | number | boolean> {
  const prefs = new Map<string, string | number | boolean>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*user_pref\(("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false)\);\s*$/.exec(line);
    if (!match) continue;
    try { prefs.set(JSON.parse(match[1]!), JSON.parse(match[2]!)); } catch { /* Ignore malformed preferences. */ }
  }
  return prefs;
}

export function accountsFromPreferences(text: string) {
  const p = parsePreferences(text);
  const get = (key: string) => p.get(key);
  const str = (key: string) => String(get(key) ?? "");
  const security = (key: string) => get(key) === 3 ? "tls" : get(key) === 2 ? "starttls" : null;
  const accounts = str("mail.accountmanager.accounts").split(",").filter(Boolean);
  return accounts.flatMap((account) => {
    const server = str(`mail.account.${account}.server`);
    if (str(`mail.server.${server}.type`) !== "imap") return [];
    const imapSecurity = security(`mail.server.${server}.socketType`);
    return str(`mail.account.${account}.identities`).split(",").filter(Boolean).map(identity => {
      const smtp = str(`mail.identity.${identity}.smtpServer`) || str("mail.smtp.defaultserver");
      const smtpSecurity = security(`mail.smtpserver.${smtp}.try_ssl`);
      return { label: str(`mail.server.${server}.name`), email: str(`mail.identity.${identity}.useremail`), senderName: str(`mail.identity.${identity}.fullName`), imapHost: str(`mail.server.${server}.hostname`), imapPort: Number(get(`mail.server.${server}.port`) || (imapSecurity === "starttls" ? 143 : 993)), imapSecurity, username: str(`mail.server.${server}.userName`), smtpHost: str(`mail.smtpserver.${smtp}.hostname`), smtpPort: Number(get(`mail.smtpserver.${smtp}.port`) || (smtpSecurity === "starttls" ? 587 : 465)), smtpSecurity, smtpUsername: str(`mail.smtpserver.${smtp}.username`), imapAuthMethod: get(`mail.server.${server}.authMethod`) ?? null, smtpAuthMethod: get(`mail.smtpserver.${smtp}.authMethod`) ?? null };
    });
  });
}

export async function discoverThunderbirdProfiles(root = defaultThunderbirdRoot()) {
  const ini = await readFile(join(root, "profiles.ini"), "utf8");
  return ini.split(/^\s*\[/m).slice(1).flatMap((section) => {
    const lines = section.split(/\r?\n/); if (!/^Profile\d+\]/.test(lines[0] ?? "")) return [];
    const fields = new Map(lines.slice(1).map((line) => { const i = line.indexOf("="); return i < 0 ? ["", ""] : [line.slice(0, i), line.slice(i + 1)]; }));
    const path = fields.get("Path"); if (!path) return [];
    return [{ name: fields.get("Name") || path, path: fields.get("IsRelative") === "0" || isAbsolute(path) ? resolve(path) : resolve(root, path) }];
  });
}
export async function readThunderbirdProfile(path: string) { return accountsFromPreferences(await readFile(join(path, "prefs.js"), "utf8")); }
function defaultThunderbirdRoot() { return process.platform === "win32" ? join(process.env.APPDATA || homedir(), "Thunderbird") : process.platform === "darwin" ? join(homedir(), "Library", "Thunderbird") : join(homedir(), ".thunderbird"); }
