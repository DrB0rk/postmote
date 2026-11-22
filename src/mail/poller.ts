import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { withImap } from "./operations.ts";

const FOLDER = "INBOX";
const BATCH_SIZE = 200;
const LEASE_MS = 120_000;

type FolderState = { uidvalidity: number | null; highest_uid: number };
type Indexed = { uid: number; internetMessageId: string | null; from: string; to: string; subject: string; date: string | null; flags: string; size: number };

export class PollInProgress extends Error {}

/** Poll one bounded batch, protected by a cross-process lease. */
export async function pollMailbox(db: Database, dataDir: string, mailboxId: string) {
  const owner = randomBytes(16).toString("hex");
  const now = Date.now();
  const lease = db.query(`INSERT INTO mailbox_poll_locks(mailbox_id,owner,expires_at) VALUES(?,?,?)
    ON CONFLICT(mailbox_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE mailbox_poll_locks.expires_at<? RETURNING owner`).get(mailboxId, owner, now + LEASE_MS, now);
  if (!lease) throw new PollInProgress();
  const heartbeat = setInterval(() => {
    try { db.query("UPDATE mailbox_poll_locks SET expires_at=? WHERE mailbox_id=? AND owner=?").run(Date.now() + LEASE_MS, mailboxId, owner); } catch { /* The owner will fail its lease check before committing. */ }
  }, LEASE_MS / 3);
  heartbeat.unref();
  try {
    return await withImap(db, dataDir, mailboxId, async client => {
      const lock = await client.getMailboxLock(FOLDER, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error("No mailbox selected");
        const uidValidity = Number(mailbox.uidValidity);
        if (!Number.isSafeInteger(uidValidity) || uidValidity < 1 || uidValidity > 4294967295) throw new Error("Invalid UIDVALIDITY");
        const old = db.query("SELECT uidvalidity,highest_uid FROM folder_state WHERE mailbox_id=? AND folder_path=?").get(mailboxId, FOLDER) as FolderState | null;
        const changed = old?.uidvalidity !== uidValidity;
        const checkpoint = changed ? 0 : old?.highest_uid ?? 0;
        const search = mailbox.exists ? await client.search({ all: true }, { uid: true }) : [];
        if (!search) throw new Error("IMAP search failed");
        const all = [...new Set(search.filter(uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 4294967295))].sort((a,b) => a-b);
        const remaining = all.filter(uid => uid > checkpoint);
        const batch = remaining.slice(0, BATCH_SIZE);
        const done = remaining.length <= BATCH_SIZE;
        const fetched = batch.length ? await client.fetchAll(batch.join(","), { uid: true, envelope: true, flags: true, size: true, internalDate: true }, { uid: true }) : [];
        const rows: Indexed[] = fetched.map(message => {
          const addresses = (items: { name?: string; address?: string }[] | undefined) => JSON.stringify((items ?? []).slice(0,100).map(a => ({ name: (a.name ?? "").slice(0,512), address: (a.address ?? "").slice(0,512) })));
          return { uid: message.uid, internetMessageId: message.envelope?.messageId?.slice(0,998) ?? null, from: addresses(message.envelope?.from), to: addresses(message.envelope?.to), subject: (message.envelope?.subject ?? "").slice(0,998), date: message.internalDate instanceof Date && !Number.isNaN(message.internalDate.getTime()) ? message.internalDate.toISOString() : null, flags: JSON.stringify([...(message.flags ?? [])].slice(0,100)), size: message.size ?? 0 };
        });
        const at = new Date().toISOString();
        return db.transaction(() => {
          const held = db.query("SELECT 1 FROM mailbox_poll_locks WHERE mailbox_id=? AND owner=? AND expires_at>?").get(mailboxId, owner, Date.now());
          if (!held) throw new Error("Poll lease expired");
          let newCount = 0, updatedCount = 0, deletedCount = 0;
          if (changed) db.query("DELETE FROM message_index WHERE mailbox_id=? AND folder_path=?").run(mailboxId, FOLDER);
          const exists = db.query("SELECT 1 FROM message_index WHERE mailbox_id=? AND folder_path=? AND uidvalidity=? AND uid=?");
          const upsert = db.query(`INSERT INTO message_index(mailbox_id,folder_path,uidvalidity,uid,internet_message_id,thread_parent_id,from_json,to_json,subject,internal_date,flags_json,snippet,size_bytes)
            VALUES(?,?,?,?,?,NULL,?,?,?,?,?,'',?) ON CONFLICT(mailbox_id,folder_path,uidvalidity,uid) DO UPDATE SET internet_message_id=excluded.internet_message_id,from_json=excluded.from_json,to_json=excluded.to_json,subject=excluded.subject,internal_date=excluded.internal_date,flags_json=excluded.flags_json,size_bytes=excluded.size_bytes`);
          for (const row of rows) {
            if (exists.get(mailboxId,FOLDER,uidValidity,row.uid)) updatedCount++; else newCount++;
            upsert.run(mailboxId,FOLDER,uidValidity,row.uid,row.internetMessageId,row.from,row.to,row.subject,row.date,row.flags,row.size);
          }
          if (done) {
            const live = new Set(all);
            const indexed = db.query("SELECT uid FROM message_index WHERE mailbox_id=? AND folder_path=? AND uidvalidity=?").all(mailboxId,FOLDER,uidValidity) as {uid:number}[];
            const remove = db.query("DELETE FROM message_index WHERE mailbox_id=? AND folder_path=? AND uidvalidity=? AND uid=?");
            for (const row of indexed) if (!live.has(row.uid)) deletedCount += remove.run(mailboxId,FOLDER,uidValidity,row.uid).changes;
          }
          const next = done ? 0 : batch[batch.length-1]!;
          db.query(`INSERT INTO folder_state(mailbox_id,folder_path,uidvalidity,highest_uid,last_sync_at,last_error) VALUES(?,?,?,?,?,NULL)
            ON CONFLICT(mailbox_id,folder_path) DO UPDATE SET uidvalidity=excluded.uidvalidity,highest_uid=excluded.highest_uid,last_sync_at=excluded.last_sync_at,last_error=NULL`).run(mailboxId,FOLDER,uidValidity,next,at);
          db.query("UPDATE mailboxes SET status='idle' WHERE id=?").run(mailboxId);
          return { polledAt: at, newCount, updatedCount, deletedCount, remaining: Math.max(0,remaining.length-batch.length) };
        })();
      } finally { lock.release(); }
    });
  } catch (error) {
    try {
      db.transaction(() => {
        if (!db.query("SELECT 1 FROM mailbox_poll_locks WHERE mailbox_id=? AND owner=? AND expires_at>?").get(mailboxId,owner,Date.now())) return;
        db.query(`INSERT INTO folder_state(mailbox_id,folder_path,last_error) VALUES(?,?,'Mailbox poll failed.') ON CONFLICT(mailbox_id,folder_path) DO UPDATE SET last_error=excluded.last_error`).run(mailboxId,FOLDER);
        db.query("UPDATE mailboxes SET status='error' WHERE id=?").run(mailboxId);
      })();
    } catch { /* The mailbox may have been removed during polling. */ }
    throw error;
  } finally {
    clearInterval(heartbeat);
    db.query("DELETE FROM mailbox_poll_locks WHERE mailbox_id=? AND owner=?").run(mailboxId, owner);
  }
}

export function startPollScheduler(db: Database, dataDir: string, options: { now?: () => number; random?: () => number; tickMs?: number; poll?: (db: Database, dataDir: string, id: string) => Promise<{ remaining:number }> } = {}) {
  const nowMs = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const poll = options.poll ?? pollMailbox;
  const due = new Map<string, { at: number; failures: number }>();
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    const boxes = db.query("SELECT id,poll_seconds FROM mailboxes ORDER BY id").all() as { id:string; poll_seconds:number }[];
    const now = nowMs();
    for (const box of boxes) if (!due.has(box.id)) due.set(box.id, { at:now + Math.round(box.poll_seconds * 1000 * (0.9 + random() * 0.2)), failures:0 });
    for (const id of due.keys()) if (!boxes.some(box => box.id === id)) due.delete(id);
    const box = boxes.find(item => due.get(item.id)!.at <= now);
    if (!box) return;
    active = (async () => {
      const state = due.get(box.id)!;
      try {
        const result = await poll(db,dataDir,box.id);
        state.failures = 0;
        state.at = nowMs() + (result.remaining ? 1000 : Math.round(box.poll_seconds * 1000 * (0.9 + random() * 0.2)));
      } catch (error) {
        if (error instanceof PollInProgress) state.at = nowMs() + 30_000;
        else { state.failures++; state.at = nowMs() + Math.min(1_800_000, 30_000 * 2 ** Math.min(state.failures - 1, 6)); }
      }
    })().finally(() => { active = null; });
  };
  const timer = setInterval(tick, options.tickMs ?? 1000);
  timer.unref();
  return { async stop() { stopped = true; clearInterval(timer); if (active) await active; } };
}
