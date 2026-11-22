import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { Database } from "bun:sqlite";
import { decryptSecret } from "../vault.ts";

type Mailbox = { id: string; email: string; sender_name: string; sender_email: string | null; imap_host: string; imap_port: number; imap_security: string; username: string; encrypted_secret: string; smtp_enabled: number; smtp_host: string | null; smtp_port: number | null; smtp_security: string | null; smtp_username: string | null };
export async function credentials(db: Database, dataDir: string, id: string) {
  const box = db.query("SELECT * FROM mailboxes WHERE id=?").get(id) as Mailbox | null;
  if (!box) throw new Error("Mailbox unavailable");
  const secret = JSON.parse(await decryptSecret(dataDir, id, box.encrypted_secret)) as { imapPassword: string; smtpPassword: string | null };
  return { box, secret };
}
export async function withImap<T>(db: Database, dataDir: string, id: string, action: (client: ImapFlow) => Promise<T>) {
  const { box, secret } = await credentials(db, dataDir, id);
  const client = new ImapFlow({ host: box.imap_host, port: box.imap_port, secure: box.imap_security === "tls", doSTARTTLS: box.imap_security === "starttls", auth: { user: box.username, pass: secret.imapPassword }, tls: { rejectUnauthorized: true }, logger: false, disableAutoIdle: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });
  try { await client.connect(); return await action(client); } finally { try { await client.logout(); } catch { client.close(); } }
}
export async function sendMail(db: Database, dataDir: string, id: string, message: { to: string | string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; inReplyTo?: string; references?: string[] }, sender: { name: string; address: string }) {
  const { box, secret } = await credentials(db, dataDir, id);
  if (!box.smtp_enabled || !box.smtp_host || !box.smtp_port || !box.smtp_username || !secret.smtpPassword) throw new Error("SMTP is not configured");
  const transport = nodemailer.createTransport({ host: box.smtp_host, port: box.smtp_port, secure: box.smtp_security === "tls", requireTLS: box.smtp_security === "starttls", auth: { user: box.smtp_username, pass: secret.smtpPassword }, tls: { rejectUnauthorized: true }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });
  try { return await transport.sendMail({ from: sender, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.text, inReplyTo:message.inReplyTo, references:message.references }); } finally { transport.close(); }
}
