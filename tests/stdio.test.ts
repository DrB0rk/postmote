import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openDatabase } from "../src/db.ts";
import { ensureMasterKey } from "../src/vault.ts";

const executable = process.env.POSTMOTE_TEST_BINARY || process.execPath;
const args = process.env.POSTMOTE_TEST_BINARY ? ["mcp", "stdio"] : [join(import.meta.dir, "../src/main.ts"), "mcp", "stdio"];
const token = "test-token-" + "a".repeat(48);

describe("MCP stdio", () => {
  test("serves tools with agent grants and applies token revocation to an existing connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postmote-stdio-"));
    await ensureMasterKey(dir);
    const db = await openDatabase(dir);
    const now = new Date().toISOString();
    db.query("INSERT INTO agents(id,label,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?)").run("agent", "Agent", createHash("sha256").update(token).digest("hex"), token.slice(0, 8), now);
    db.query("INSERT INTO mailboxes(id,label,email,imap_host,imap_port,imap_security,username,encrypted_secret,poll_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("box", "Mailbox", "owner@example.test", "imap.example.test", 993, "tls", "owner", "encrypted", 120, now, now);
    db.query("INSERT INTO agent_mailbox_grants(agent_id,mailbox_id,capability,created_at) VALUES(?,?,?,?)").run("agent", "box", "mail.read", now);
    const child = spawn(executable, args, { env: { ...process.env, POSTMOTE_DATA_DIR: dir, POSTMOTE_AGENT_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const call = async (message: object) => {
      child.stdin.write(JSON.stringify(message) + "\n");
      const line = await Promise.race([lines.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP response timed out")), 5000))]);
      if (line.done) throw new Error("MCP server exited before responding");
      return JSON.parse(line.value);
    };
    try {
      const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
      expect(init.result.serverInfo.name).toBe("postmote");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("mail_send_request");
      const accounts = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mail_accounts", arguments: {} } });
      expect(accounts.result.structuredContent.accounts.map((box: { id: string }) => box.id)).toEqual(["box"]);
      const denied = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mail_send_request", arguments: { mailboxId: "box", to: "berk@berkderooij.nl", subject: "test", text: "test", idempotencyKey: "test-request-1" } } });
      expect(denied.result.isError).toBe(true);
      expect(db.query("SELECT count(*) AS count FROM send_requests").get()).toEqual({ count: 0 });
      const noSearch = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mail_search", arguments: { mailboxId: "box", query: "test" } } });
      expect(noSearch.result.isError).toBe(true);
      expect(JSON.stringify(noSearch)).toContain("FORBIDDEN");
      const wrongMailbox = await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mail_folders", arguments: { mailboxId: "another-box" } } });
      expect(wrongMailbox.result.isError).toBe(true);
      expect(JSON.stringify(wrongMailbox)).toContain("FORBIDDEN");
      const noAttachments = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "mail_attachment_read", arguments: { message: { mailboxId:"box", folder:"INBOX", uidValidity:1, uid:1 }, attachmentId:"0" } } });
      expect(noAttachments.result.isError).toBe(true);
      expect(JSON.stringify(noAttachments)).toContain("FORBIDDEN");
      for (const [id,name,args] of [
        [10,"mail_flags",{message:{mailboxId:"box",folder:"INBOX",uidValidity:1,uid:1},operation:"add",flags:["\\Seen"]}],
        [11,"mail_reply_draft",{message:{mailboxId:"box",folder:"INBOX",uidValidity:1,uid:1}}],
        [12,"mail_forward_draft",{message:{mailboxId:"box",folder:"INBOX",uidValidity:1,uid:1},to:["berk@berkderooij.nl"]}],
      ] as const) {
        const deniedOperation=await call({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}});
        expect(deniedOperation.result.isError).toBe(true);
        expect(JSON.stringify(deniedOperation)).toContain("FORBIDDEN");
      }
      const missingValidity = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "mail_read", arguments: { mailboxId: "box", uid: 1 } } });
      expect(missingValidity.result?.isError || missingValidity.error).toBeTruthy();
      const resourceList=await call({jsonrpc:"2.0",id:13,method:"resources/list",params:{}});
      expect(resourceList.result.resources.some((resource:{uri:string}) => resource.uri==="postmote://accounts")).toBe(true);
      const accountResource=await call({jsonrpc:"2.0",id:14,method:"resources/read",params:{uri:"postmote://accounts"}});
      expect(JSON.parse(accountResource.result.contents[0].text).accounts.map((box:{id:string})=>box.id)).toEqual(["box"]);
      const noResource=await call({jsonrpc:"2.0",id:15,method:"resources/read",params:{uri:"postmote://mailbox/another-box/status"}});
      expect(noResource.error).toBeTruthy();
      const promptList=await call({jsonrpc:"2.0",id:16,method:"prompts/list",params:{}});
      expect(promptList.result.prompts.map((prompt:{name:string})=>prompt.name)).toContain("summarize_inbox");
      const prompt=await call({jsonrpc:"2.0",id:17,method:"prompts/get",params:{name:"summarize_inbox",arguments:{mailboxId:"box"}}});
      expect(prompt.result.messages[0].content.text).toContain("untrusted data");
      const noPrompt=await call({jsonrpc:"2.0",id:18,method:"prompts/get",params:{name:"prepare_reply",arguments:{mailboxId:"box"}}});
      expect(noPrompt.error).toBeTruthy();
      db.query("UPDATE agents SET token_hash=? WHERE id='agent'").run("rotated");
      const revoked = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mail_accounts", arguments: {} } });
      expect(revoked.result.isError).toBe(true);
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else { child.once("exit", () => resolve()); setTimeout(() => child.kill(), 1000).unref(); } });
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("fails closed without a token", async () => {
    const child = spawn(executable, args, { env: { ...process.env, POSTMOTE_AGENT_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
    const output = await new Response(child.stdout as unknown as ReadableStream).text().catch(() => "");
    const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
    expect(code).toBe(2);
    expect(output).toBe("");
  });
});
