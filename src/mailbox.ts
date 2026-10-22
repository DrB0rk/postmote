import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { z } from "zod";

const email = z.string().email().refine((value) => Buffer.byteLength(value, "utf8") <= 254 && !/[\r\n\0]/.test(value));
const host = z.string().min(1).max(253).refine((value) => {
  if (/[\s\r\n\0/@?#]/.test(value) || value.includes("://")) return false;
  if (isIP(value)) return true;
  if (value.includes(":")) return false;
  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return false;
  return ascii.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}, "Enter a hostname or IP address, not a URL").transform((value) => isIP(value) ? value : domainToASCII(value).toLowerCase());

export const imapConnectionInputSchema = z.object({
  imapHost: host,
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecurity: z.enum(["tls", "starttls"]).default("tls"),
  username: z.string().min(1).max(320).refine((v) => !/[\r\n\0]/.test(v)),
  password: z.string().min(1).max(4096),
});

export const smtpConnectionInputSchema = z.object({
  smtpHost: host,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: z.enum(["tls", "starttls"]),
  smtpUsername: z.string().min(1).max(320).refine((v) => !/[\r\n\0]/.test(v)),
  smtpPassword: z.string().min(1).max(4096),
});

export const mailboxInputSchema = z.object({
  label: z.string().trim().normalize("NFC").max(80).optional(),
  email,
  senderName: z.string().max(100).refine((v) => !/[\r\n\0]/.test(v)).default(""),
  senderEmail: email.optional(),
  imapHost: host,
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecurity: z.enum(["tls", "starttls"]).default("tls"),
  mailboxRoot: z.string().max(512).refine((v) => !/[\r\n\0]/.test(v)).optional(),
  smtpHost: host.optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecurity: z.enum(["tls", "starttls"]).optional(),
  smtpEnabled: z.boolean().default(true),
  smtpUsername: z.string().max(320).refine((v) => !/[\r\n\0]/.test(v)).optional(),
  smtpPassword: z.string().max(4096).optional(),
  username: z.string().min(1).max(320).refine((v) => !/[\r\n\0]/.test(v)),
  password: z.string().min(1).max(4096),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
}).strict().superRefine((value, ctx) => {
  if (!value.smtpEnabled) return;
  if (!value.smtpHost) ctx.addIssue({ code: "custom", path: ["smtpHost"], message: "SMTP host is required unless sending is disabled" });
  if (!value.smtpUsername) ctx.addIssue({ code: "custom", path: ["smtpUsername"], message: "SMTP username is required" });
  if (!value.smtpPassword) ctx.addIssue({ code: "custom", path: ["smtpPassword"], message: "SMTP password is required" });
  if (!value.smtpPort) ctx.addIssue({ code: "custom", path: ["smtpPort"], message: "SMTP port is required" });
  if (!value.smtpSecurity) ctx.addIssue({ code: "custom", path: ["smtpSecurity"], message: "SMTP security mode is required" });
});
export type MailboxInput = z.infer<typeof mailboxInputSchema>;
