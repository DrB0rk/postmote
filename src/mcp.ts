import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const empty = z.object({}).strict();
const mailboxId = z.object({ mailboxId: z.string().min(1).max(128) }).strict();

export function createAgentMcpHandler(db: Database) {
  return createMcpHandler((context) => {
    const agentId = context.authInfo?.clientId;
    const server = new McpServer({ name: "postmote", version: "0.1.0" });

    server.registerTool("mail_accounts", {
      title: "List assigned mailboxes",
      description: "List mailboxes with at least one permission granted to the authenticated agent.",
      inputSchema: empty,
    }, async () => {
      if (!agentId) return denied("UNAUTHORIZED", "Agent authentication is required.");
      const accounts = db.query(`SELECT DISTINCT m.id, m.label, m.email, m.status AS imapStatus,
          (m.smtp_host IS NOT NULL) AS smtpEnabled, 0 AS unreadCount
        FROM mailboxes m JOIN agent_mailbox_grants g ON g.mailbox_id=m.id
        JOIN agents a ON a.id=g.agent_id WHERE a.id=? AND a.enabled=1 ORDER BY m.label`).all(agentId);
      return result({ accounts });
    });

    server.registerTool("mail_status", {
      title: "Get mailbox status",
      description: "Get non-sensitive connection status for an assigned mailbox.",
      inputSchema: mailboxId,
    }, async ({ mailboxId: id }) => {
      if (!agentId) return denied("UNAUTHORIZED", "Agent authentication is required.");
      const allowed = db.query(`SELECT m.id,m.status,m.smtp_host FROM mailboxes m
        JOIN agent_mailbox_grants g ON g.mailbox_id=m.id JOIN agents a ON a.id=g.agent_id
        WHERE m.id=? AND a.id=? AND a.enabled=1 AND g.capability='mail.read'`).get(id, agentId) as { id: string; status: string; smtp_host: string | null } | null;
      if (!allowed) return denied("FORBIDDEN", "Mailbox is unavailable or the agent lacks mail.read permission.");
      return result({ imap: { connected: allowed.status === "connected", lastPollAt: null, lastError: null }, smtpEnabled: allowed.smtp_host !== null, unreadCount: 0, nextPollAt: null });
    });
    return server;
  }, { legacy: "stateless" });
}

export function authenticateAgentToken(db: Database, token: string): AuthInfo | null {
  if (token.length < 40 || token.length > 256) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const agent = db.query("SELECT id FROM agents WHERE token_hash=? AND enabled=1").get(tokenHash) as { id: string } | null;
  if (!agent) return null;
  db.query("UPDATE agents SET last_used_at=? WHERE id=?").run(new Date().toISOString(), agent.id);
  return { token, clientId: agent.id, scopes: [] };
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

function denied(code: string, message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code, message } }) }] };
}
