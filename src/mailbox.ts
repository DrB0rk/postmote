import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { z } from "zod";

const email = z.string().max(254).email().refine((value) => !/[\r\n\0]/.test(value));
const host = z.string().min(1).max(253).refine((value) => {
  if (/[\s\r\n\0/@?#]/.test(value) || value.includes("://")) return false;
  if (isIP(value)) return true;
  if (value.includes(":")) return false;
  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return false;
  return ascii.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}, "Enter a hostname or IP address, not a URL");

export const mailboxInputSchema = z.object({
  label: z.string().trim().max(80).optional(),
  email,
  imapHost: host,
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecurity: z.enum(["tls", "starttls"]).default("tls"),
  smtpHost: host.optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecurity: z.enum(["tls", "starttls"]).optional(),
  username: z.string().min(1).max(320).refine((v) => !/[\r\n\0]/.test(v)),
  password: z.string().min(1).max(4096),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
}).strict();
export type MailboxInput = z.infer<typeof mailboxInputSchema>;
