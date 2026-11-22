import type { Database } from "bun:sqlite";
import { audit } from "./audit.ts";

export const DELIVERY_LEASE_MS=120_000;

/** Keep an active SMTP submission distinguishable from a crashed process. */
export function holdDeliveryLease(db:Database,id:string,owner:string) {
  const timer=setInterval(()=>{
    try { db.query("UPDATE send_requests SET sending_lease_expires_at=? WHERE id=? AND state='sending' AND sending_owner=?").run(Date.now()+DELIVERY_LEASE_MS,id,owner); } catch { /* A failed heartbeat is detected by recovery. */ }
  },DELIVERY_LEASE_MS/3);
  timer.unref();
  return () => clearInterval(timer);
}

export function finishDelivery(db:Database,id:string,owner:string,mailboxId:string,state:"sent"|"delivery_unknown"|"failed") {
  return db.transaction(()=>{
    const updated=db.query("UPDATE send_requests SET state=?,updated_at=?,sending_owner=NULL,sending_lease_expires_at=NULL WHERE id=? AND state='sending' AND sending_owner=?").run(state,new Date().toISOString(),id,owner);
    if (updated.changes) audit(db,{principalType:"system",mailboxId,action:"send.submit",targetId:id,outcome:state});
    return updated.changes>0;
  }).immediate();
}

/** Called by the daemon; live submissions keep their lease and are not recovered. */
export function recoverInterruptedDeliveries(db: Database, now = new Date().toISOString(), recoverOwner = false): number {
  return db.transaction(() => {
    const pending=db.query("SELECT id,mailbox_id FROM send_requests WHERE state='sending' AND (sending_lease_expires_at IS NULL OR sending_lease_expires_at<=? OR (?=1 AND sending_origin='owner'))").all(Date.parse(now),recoverOwner ? 1 : 0) as {id:string;mailbox_id:string}[];
    const update=db.query("UPDATE send_requests SET state='delivery_unknown',updated_at=?,sending_owner=NULL,sending_lease_expires_at=NULL WHERE id=? AND state='sending' AND (sending_lease_expires_at IS NULL OR sending_lease_expires_at<=? OR (?=1 AND sending_origin='owner'))");
    let count=0;
    for (const request of pending) if (update.run(now,request.id,Date.parse(now),recoverOwner ? 1 : 0).changes) { count++; audit(db,{principalType:"system",mailboxId:request.mailbox_id,action:"send.recover",targetId:request.id,outcome:"delivery_unknown",time:now}); }
    return count;
  }).immediate();
}
