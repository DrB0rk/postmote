import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_credentials (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_sessions (id_hash TEXT PRIMARY KEY, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_security TEXT NOT NULL CHECK (imap_security IN ('tls','starttls')),
  smtp_host TEXT, smtp_port INTEGER, smtp_security TEXT CHECK (smtp_security IS NULL OR smtp_security IN ('tls','starttls')),
  username TEXT NOT NULL, encrypted_secret TEXT NOT NULL, auth_kind TEXT NOT NULL DEFAULT 'password',
  poll_seconds INTEGER NOT NULL CHECK (poll_seconds BETWEEN 60 AND 3600), status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(email, imap_host)
);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE IF NOT EXISTS agent_mailbox_grants (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, capability TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(agent_id, mailbox_id, capability));
CREATE TABLE IF NOT EXISTS folder_state (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, folder_path TEXT NOT NULL, uidvalidity INTEGER, highest_uid INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, last_error TEXT, PRIMARY KEY(mailbox_id, folder_path));
CREATE TABLE IF NOT EXISTS message_index (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, folder_path TEXT NOT NULL, uidvalidity INTEGER NOT NULL, uid INTEGER NOT NULL,
  internet_message_id TEXT, thread_parent_id TEXT, from_json TEXT NOT NULL, to_json TEXT NOT NULL, subject TEXT NOT NULL,
  internal_date TEXT, flags_json TEXT NOT NULL, snippet TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  PRIMARY KEY(mailbox_id, folder_path, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS message_date_idx ON message_index(mailbox_id, folder_path, internal_date);
CREATE INDEX IF NOT EXISTS message_id_idx ON message_index(internet_message_id);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), agent_id TEXT REFERENCES agents(id), mime_fields_json TEXT NOT NULL, encrypted_body TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS send_requests (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), agent_id TEXT REFERENCES agents(id), draft_id TEXT NOT NULL REFERENCES drafts(id), draft_revision INTEGER NOT NULL, approved_payload_hash TEXT, state TEXT NOT NULL, approval_expires_at TEXT NOT NULL, approved_at TEXT, smtp_started_at TEXT, smtp_result_json TEXT, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id, idempotency_key));
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, time TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT, mailbox_id TEXT, action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
`;

export async function openDatabase(dataDir: string): Promise<Database> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dataDir, 0o700);
  const db = new Database(join(dataDir, "postmote.db"), { create: true });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(schema);
    db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(new Date().toISOString());
    const version = db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    if (version.version < 2) {
      db.exec(`ALTER TABLE mailboxes ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE mailboxes ADD COLUMN sender_email TEXT;
        ALTER TABLE mailboxes ADD COLUMN smtp_username TEXT;
        ALTER TABLE mailboxes ADD COLUMN smtp_enabled INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE mailboxes ADD COLUMN mailbox_root TEXT;
        UPDATE mailboxes SET smtp_enabled = CASE WHEN smtp_host IS NULL THEN 0 ELSE 1 END;
        INSERT INTO schema_migrations(version, applied_at) VALUES(2, '${new Date().toISOString()}');`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    db.close();
    throw error;
  }
  const dbPath = join(dataDir, "postmote.db");
  if (process.platform !== "win32") {
    await chmod(dbPath, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try { await chmod(dbPath + suffix, 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return db;
}
