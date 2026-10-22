import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export type ConnectionSecurity = "tls" | "starttls";

export interface ImapConnectionInput {
  host: string;
  port: number;
  security: ConnectionSecurity;
  username: string;
  password: string;
}

export interface SmtpConnectionInput extends ImapConnectionInput {}

export interface ConnectionTestResult {
  ok: boolean;
  stage: "connected" | "dns" | "tcp" | "tls" | "authentication" | "timeout" | "unknown";
  message: string;
}

export async function testImapConnection(input: ImapConnectionInput): Promise<ConnectionTestResult> {
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.security === "tls",
    doSTARTTLS: input.security === "starttls",
    auth: { user: input.username, pass: input.password },
    tls: { rejectUnauthorized: true },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await client.connect();
    return { ok: true, stage: "connected", message: "TLS connection and authentication succeeded." };
  } catch (error) {
    return classifyConnectionError(error);
  } finally {
    try { await client.logout(); } catch { /* A failed connection may have no socket to close. */ }
  }
}

export async function testSmtpConnection(input: SmtpConnectionInput): Promise<ConnectionTestResult> {
  const transporter = nodemailer.createTransport({
    host: input.host,
    port: input.port,
    secure: input.security === "tls",
    requireTLS: input.security === "starttls",
    auth: { user: input.username, pass: input.password },
    tls: { rejectUnauthorized: true },
    logger: false,
    transactionLog: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await transporter.verify();
    return { ok: true, stage: "connected", message: "TLS connection and authentication succeeded." };
  } catch (error) {
    return classifyConnectionError(error);
  } finally {
    transporter.close();
  }
}

function classifyConnectionError(error: unknown): ConnectionTestResult {
  const candidate = error as { code?: string; command?: string; responseCode?: number };
  const code = (candidate.code ?? "").toUpperCase();
  const command = (candidate.command ?? "").toUpperCase();
  if (["EAUTH", "AUTHENTICATIONFAILED", "INVALID_CREDENTIALS"].includes(code) || candidate.responseCode === 535 || command.includes("AUTH")) {
    return { ok: false, stage: "authentication", message: "The server rejected the supplied username or password." };
  }
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ETLS"].includes(code)) {
    return { ok: false, stage: "tls", message: "TLS negotiation or certificate verification failed." };
  }
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return { ok: false, stage: "dns", message: "The mail host could not be resolved." };
  if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNREFUSED", "ECONNRESET"].includes(code)) {
    return { ok: false, stage: code === "ETIMEDOUT" ? "timeout" : "tcp", message: "The server could not be reached or timed out." };
  }
  return { ok: false, stage: "unknown", message: "Connection failed. Check the server settings and try again." };
}
