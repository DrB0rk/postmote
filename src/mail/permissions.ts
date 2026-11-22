import type { Database } from "bun:sqlite";

/** A dedicated inbox grants the owner-selected agent all mailbox operations. */
export function agentMay(db:Database,agentId:string,mailboxId:string,capability:string):boolean {
  return !!db.query(`SELECT 1 FROM agents a WHERE a.id=? AND a.enabled=1 AND (
    EXISTS(SELECT 1 FROM agent_mailbox_grants g WHERE g.agent_id=a.id AND g.mailbox_id=? AND g.capability=?) OR
    EXISTS(SELECT 1 FROM agent_inboxes i WHERE i.agent_id=a.id AND i.mailbox_id=?))`).get(agentId,mailboxId,capability,mailboxId);
}
export function dedicatedInbox(db:Database,agentId:string,mailboxId:string):boolean {
  return !!db.query("SELECT 1 FROM agent_inboxes i JOIN agents a ON a.id=i.agent_id WHERE i.agent_id=? AND i.mailbox_id=? AND a.enabled=1").get(agentId,mailboxId);
}
