import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dedicated inbox assignment grants only the selected agent mailbox access",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"postmote-agent-inbox-"));
  const probe=createServer(); await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve)); const address=probe.address(); if (!address || typeof address==="string") throw new Error("Cannot allocate port"); const port=address.port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const binary=process.env.POSTMOTE_TEST_BINARY;
  const child=Bun.spawn(binary ? [binary,"serve"] : [process.execPath,"src/main.ts","serve"],{env:{...process.env,POSTMOTE_DATA_DIR:dir,POSTMOTE_PORT:String(port)},stdout:"ignore",stderr:"ignore"});
  const base=`http://127.0.0.1:${port}`;
  const request=async(path:string, options:RequestInit={})=>{const response=await fetch(base+path,options); return {response,body:await response.json() as Record<string,any>};};
  try {
    for(let i=0;;i++){try{if((await fetch(base+"/api/health")).ok)break}catch{} if(i===100)throw new Error("Daemon did not start");await Bun.sleep(50)}
    const json={"content-type":"application/json"};
    await request("/api/setup/initialize",{method:"POST",headers:json,body:JSON.stringify({password:"integration password"})});
    const login=await request("/api/auth/login",{method:"POST",headers:json,body:JSON.stringify({password:"integration password"})});
    const headers={...json,cookie:login.response.headers.get("set-cookie")!};
    await request("/api/settings",{method:"PUT",headers,body:JSON.stringify({personalEmail:"berk@berkderooij.nl"})});
    const personal=(await request("/api/mailboxes",{method:"POST",headers,body:JSON.stringify({email:"berk@berkderooij.nl",imapHost:"localhost",username:"personal",password:"test",smtpEnabled:false})})).body;
    const inbox=(await request("/api/mailboxes",{method:"POST",headers,body:JSON.stringify({email:"agent@example.test",imapHost:"localhost",username:"agent",password:"test",smtpEnabled:true,smtpHost:"localhost",smtpPort:465,smtpSecurity:"tls",smtpUsername:"agent",smtpPassword:"test"})})).body;
    const agent=(await request("/api/agents",{method:"POST",headers,body:JSON.stringify({label:"Agent"})})).body;
    const other=(await request("/api/agents",{method:"POST",headers,body:JSON.stringify({label:"Other"})})).body;
    const self=(await request("/api/agents",{method:"POST",headers,body:JSON.stringify({label:"Self setup"})})).body;
    expect((await request(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers:json,body:JSON.stringify({mailboxId:inbox.id})})).response.status).toBe(401);
    expect((await request(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:personal.id})})).response.status).toBe(400);
    expect((await request(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:inbox.id})})).response.status).toBe(200);
    expect((await request(`/api/agents/${other.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:inbox.id})})).response.status).toBe(409);
    expect((await request(`/api/mailboxes/${inbox.id}`,{method:"PATCH",headers,body:JSON.stringify({smtpEnabled:false})})).response.status).toBe(409);
    const call=async(token:string,name:string,args:object)=>{const res=await fetch(base+"/mcp",{method:"POST",headers:{...json,authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});const text=await res.text();return JSON.parse(text.startsWith("event:")?text.split("\n").find(line=>line.startsWith("data:"))!.slice(5):text).result;};
    const ownSettings={email:"self@example.test",imapHost:"imap.example.test",username:"self",password:"own-imap-secret",smtpEnabled:true,smtpHost:"smtp.example.test",smtpPort:465,smtpSecurity:"tls",smtpUsername:"self",smtpPassword:"own-smtp-secret"};
    const deniedSetup=await call(self.token,"agent_inbox_setup",ownSettings);
    expect(deniedSetup.isError).toBe(true);
    expect((await request(`/api/agents/${self.id}/inbox-setup`,{method:"PUT",headers:json,body:JSON.stringify({enabled:true})})).response.status).toBe(401);
    expect((await request(`/api/agents/${self.id}/inbox-setup`,{method:"PUT",headers,body:JSON.stringify({enabled:true})})).response.status).toBe(200);
    expect((await call(self.token,"agent_inbox",{})).structuredContent.maySetUp).toBe(true);
    const setups=await Promise.all([call(self.token,"agent_inbox_setup",ownSettings),call(self.token,"agent_inbox_setup",{...ownSettings,email:"self2@example.test"})]);
    expect(setups.filter(value=>!value.isError)).toHaveLength(1);
    expect(setups.filter(value=>value.isError)).toHaveLength(1);
    const own=setups.find(value=>!value.isError).structuredContent;
    expect(JSON.stringify(own)).not.toContain("secret");
    expect((await call(self.token,"agent_inbox",{})).structuredContent).toEqual({mailboxId:own.mailboxId,personalEmail:"berk@berkderooij.nl",maySetUp:false});
    const ownUpdate=await call(self.token,"agent_inbox_update",{label:"Updated own inbox"});
    expect(ownUpdate.structuredContent.label).toBe("Updated own inbox");
    expect((await call(self.token,"agent_inbox_update",{smtpEnabled:false})).isError).toBe(true);
    expect((await call(self.token,"agent_inbox_update",{mailboxId:personal.id,label:"Hijack"})).isError).toBe(true);
    expect((await call(self.token,"agent_inbox_setup",ownSettings)).isError).toBe(true);
    expect((await call(agent.token,"agent_inbox",{})).structuredContent).toEqual({mailboxId:inbox.id,personalEmail:"berk@berkderooij.nl",maySetUp:false});
    expect((await call(other.token,"agent_inbox",{})).structuredContent).toEqual({mailboxId:null,personalEmail:null,maySetUp:false});
    const accounts=(await call(agent.token,"mail_accounts",{})).structuredContent.accounts;
    expect(accounts.map((box:{id:string})=>box.id)).toEqual([inbox.id]);
    expect(accounts[0].dedicated).toBe(1);
    expect((await call(agent.token,"mail_draft_create",{mailboxId:inbox.id,text:"Hello"})).structuredContent.revision).toBe(1);
    expect((await call(agent.token,"mail_draft_create",{mailboxId:personal.id,text:"Hello"})).isError).toBe(true);
    expect((await call(agent.token,"mail_send_owner",{mailboxId:personal.id,subject:"No",text:"No",idempotencyKey:"forbidden"})).isError).toBe(true);
    expect((await call(agent.token,"mail_send_owner",{mailboxId:inbox.id,to:"berk@berkderooij.nl",subject:"No",text:"No",idempotencyKey:"extra-recipient"})).isError).toBe(true);
    await request("/api/settings",{method:"PUT",headers,body:JSON.stringify({personalEmail:null})});
    const missing=(await call(agent.token,"mail_send_owner",{mailboxId:inbox.id,subject:"No",text:"No",idempotencyKey:"no-contact"}));
    expect(missing.isError).toBe(true); expect(JSON.stringify(missing)).toContain("PERSONAL_EMAIL_NOT_SET");

    await request(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:null})});
    expect((await call(agent.token,"mail_accounts",{})).structuredContent.accounts).toEqual([]);
    expect((await request(`/api/agents/${other.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:inbox.id})})).response.status).toBe(200);
    await request(`/api/agents/${other.id}`,{method:"DELETE",headers});
    expect((await request(`/api/agents/${agent.id}/inbox`,{method:"PUT",headers,body:JSON.stringify({mailboxId:inbox.id})})).response.status).toBe(200);
  } finally {child.kill();await child.exited;await rm(dir,{recursive:true,force:true});}
},15000);
