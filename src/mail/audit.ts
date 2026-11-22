import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export function audit(db:Database, event:{ principalType:"owner"|"agent"|"system"; principalId?:string; mailboxId?:string; action:string; targetId?:string; outcome:string; time?:string }) {
  db.query("INSERT INTO audit_events(id,time,principal_type,principal_id,mailbox_id,action,target_id,outcome) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomBytes(16).toString("hex"),event.time ?? new Date().toISOString(),event.principalType,event.principalId ?? null,event.mailboxId ?? null,event.action,event.targetId ?? null,event.outcome);
}
