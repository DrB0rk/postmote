import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cert=process.env.POSTMOTE_TEST_CERT;
const key=process.env.POSTMOTE_TEST_PRIVATE_KEY;
const recipient="berk@berkderooij.nl";

test.skipIf(!cert || !key)("restart records an interrupted SMTP submission as unknown without replay", async () => {
  const dir=await mkdtemp(join(tmpdir(),"postmote-crash-integration-"));
  const probe=createServer(); await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));
  const address=probe.address(); if (!address || typeof address==="string") throw new Error("Cannot allocate port");
  const port=address.port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
  let received=0, unexpectedRecipient=false;
  let onData:()=>void=()=>{}; const dataReceived=new Promise<void>(resolve=>{onData=resolve});
  const smtp=createTlsServer({cert:await readFile(cert!),key:await readFile(key!)},socket=>{
    let buffer="", dataMode=false;
    socket.write("220 localhost ESMTP test\r\n");
    socket.on("error",()=>{});
    socket.on("data",chunk=>{
      buffer+=chunk.toString("utf8");
      for (;;) {
        const end=buffer.indexOf("\r\n"); if (end<0) break;
        const line=buffer.slice(0,end); buffer=buffer.slice(end+2);
        if (dataMode) { if (line===".") { received++; onData(); return; } continue; }
        if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^AUTH PLAIN /i.test(line)) socket.write("235 authenticated\r\n");
        else if (/^MAIL FROM:/i.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO:/i.test(line)) { if (line.toLowerCase()!==`rcpt to:<${recipient}>`) { unexpectedRecipient=true; socket.write("550 unexpected recipient\r\n"); } else socket.write("250 ok\r\n"); }
        else if (/^DATA$/i.test(line)) { dataMode=true; socket.write("354 end with dot\r\n"); }
        else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>(resolve=>smtp.listen(0,"127.0.0.1",resolve));
  const smtpAddress=smtp.address(); if (!smtpAddress || typeof smtpAddress==="string") throw new Error("Cannot allocate SMTP port");
  const binary=process.env.POSTMOTE_TEST_BINARY;
  const start=()=>Bun.spawn(binary ? [binary,"serve"] : [process.execPath,"src/main.ts","serve"],{env:{...process.env,POSTMOTE_DATA_DIR:dir,POSTMOTE_PORT:String(port)},stdout:"ignore",stderr:"ignore"});
  let child=start();
  const base=`http://127.0.0.1:${port}`;
  const health=async () => { for (let i=0;i<100;i++) { try { if ((await fetch(base+"/api/health")).ok) return; } catch {} await Bun.sleep(100); } throw new Error("Daemon did not start"); };
  const api=async (path:string, options:RequestInit={}) => { const response=await fetch(base+path,options); const data=await response.json() as Record<string,any>; if(!response.ok) throw new Error(`API ${path}: ${response.status}`); return {data,headers:response.headers}; };
  try {
    await health();
    const json={"content-type":"application/json"};
    await api("/api/setup/initialize",{method:"POST",headers:json,body:JSON.stringify({password:"integration password"})});
    const login=await api("/api/auth/login",{method:"POST",headers:json,body:JSON.stringify({password:"integration password"})});
    const headers={...json,cookie:login.headers.get("set-cookie")!};
    const box=(await api("/api/mailboxes",{method:"POST",headers,body:JSON.stringify({email:recipient,username:"test",password:"test",imapHost:"localhost",smtpEnabled:true,smtpHost:"127.0.0.1",smtpPort:smtpAddress.port,smtpSecurity:"tls",smtpUsername:"test",smtpPassword:"test"})})).data;
    const agent=(await api("/api/agents",{method:"POST",headers,body:JSON.stringify({label:"Crash test"})})).data;
    await api(`/api/agents/${agent.id}/grants`,{method:"PUT",headers,body:JSON.stringify({grants:[{mailboxId:box.id,capabilities:["mail.send.request"]}]})});
    const mcp=async(name:string,args:object)=>{const response=await fetch(base+"/mcp",{method:"POST",headers:{...json,authorization:`Bearer ${agent.token}`,accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});const text=await response.text();const message=JSON.parse(text.startsWith("event:")?text.split("\n").find(line=>line.startsWith("data:"))!.slice(5):text);return message.result.structuredContent;};
    const pending=await mcp("mail_send_request",{mailboxId:box.id,to:recipient,subject:"Crash sandbox test",text:"Local test",idempotencyKey:"crash-test"});
    const queue=(await api("/api/send-requests",{headers})).data.requests;
    const item=queue.find((entry:{id:string})=>entry.id===pending.requestId);
    const approval=fetch(base+`/api/send-requests/${item.id}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:item.reviewHash})}).catch(()=>null);
    await Promise.race([dataReceived,Bun.sleep(15000).then(()=>{throw new Error("SMTP DATA was not received")})]);
    child.kill("SIGKILL"); await child.exited; await approval;
    child=start(); await health();
    expect((await mcp("mail_send_status",{requestId:item.id})).state).toBe("delivery_unknown");
    expect(received).toBe(1);
    expect(unexpectedRecipient).toBe(false);
    const repeat=await fetch(base+`/api/send-requests/${item.id}/approve`,{method:"POST",headers,body:JSON.stringify({reviewHash:item.reviewHash})});
    expect(repeat.status).toBe(409);
    const activity=(await api("/api/activity",{headers})).data.events;
    expect(activity.some((event:{action:string;outcome:string})=>event.action==="send.recover" && event.outcome==="delivery_unknown")).toBe(true);
  } finally {
    child.kill(); await child.exited;
    await new Promise<void>(resolve=>smtp.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
},30000);
