import { expect, test } from "bun:test";
import { findPasswords, ThunderbirdCredentialError } from "../src/thunderbird-credentials.ts";

const account={imapHost:"imap.example.test",imapPort:993,username:"incoming",smtpHost:"smtp.example.test",smtpPort:465,smtpUsername:"outgoing",imapAuthMethod:3,smtpAuthMethod:3};
const encode=(value:string)=>Buffer.from(value).toString("base64");
const decrypt=(value:string)=>Buffer.from(value,"base64").toString("utf8");
const login=(hostname:string,username:string,password:string)=>({hostname,encryptedUsername:encode(username),encryptedPassword:encode(password)});

test("Thunderbird import selects saved credentials by protocol, host, port and username", () => {
  const logins=[login("imap://imap.example.test","incoming","imap-secret"),login("smtp://smtp.example.test","outgoing","smtp-secret"),login("smtp://smtp.example.test:587","outgoing","wrong-port"),login("smtp://other.example.test","outgoing","wrong-host"),login("smtp://smtp.example.test","someone-else","wrong-user")];
  expect(findPasswords(logins,account,decrypt)).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"});
  expect(()=>findPasswords(logins.slice(0,1),account,decrypt)).toThrow(ThunderbirdCredentialError);
  expect(()=>findPasswords([...logins,login("smtp://smtp.example.test","outgoing","different")],account,decrypt)).toThrow("ambiguous");
});

const hasNssTools=process.platform==="linux" && !!Bun.which("certutil") && !!Bun.which("cc") && !!Bun.which("pkg-config") && Bun.spawnSync(["pkg-config","--exists","nss"]).exitCode===0;
test.skipIf(!hasNssTools)("reads a real NSS credential store without modifying it", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm }=await import("node:fs/promises");
  const { join }=await import("node:path");
  const { tmpdir }=await import("node:os");
  const { readThunderbirdCredentials }=await import("../src/thunderbird-credentials.ts");
  const root=await mkdtemp(join(tmpdir(),"postmote-nss-")), profile=join(root,"profile"), binary=join(root,"encrypt");
  try {
    await mkdir(profile);
    const init=Bun.spawnSync(["certutil","-N","--empty-password","-d",`sql:${profile}`],{stdout:"pipe",stderr:"pipe"});
    expect(init.exitCode).toBe(0);
    const flags=Bun.spawnSync(["pkg-config","--cflags","--libs","nss"],{stdout:"pipe"}).stdout.toString().trim().split(/\s+/);
    const build=Bun.spawnSync(["cc",join(import.meta.dir,"fixtures/nss-encrypt.c"),"-o",binary,...flags],{stdout:"pipe",stderr:"pipe"});
    if (build.exitCode!==0) throw new Error(`Could not build NSS fixture: ${build.stderr.toString()}`);
    const encrypt=(value:string)=>{const child=Bun.spawnSync([binary,`sql:${profile}`,value],{stdout:"pipe",stderr:"pipe"});if(child.exitCode!==0)throw new Error(`NSS fixture failed: ${child.exitCode}`);return child.stdout.toString("base64");};
    const logins=[{hostname:"imap://imap.example.test",encryptedUsername:encrypt("incoming"),encryptedPassword:encrypt("imap-secret")},{hostname:"smtp://smtp.example.test",encryptedUsername:encrypt("outgoing"),encryptedPassword:encrypt("smtp-secret")}];
    await writeFile(join(profile,"logins.json"),JSON.stringify({logins}));
    const keyBefore=await readFile(join(profile,"key4.db"));
    await expect(readThunderbirdCredentials(profile,account,"wrong-password")).rejects.toMatchObject({reason:"locked"});
    expect(await readThunderbirdCredentials(profile,account,"")).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"});
    expect(await readThunderbirdCredentials(profile,account,"")).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"});
    expect(await readFile(join(profile,"key4.db"))).toEqual(keyBefore);
    const protectedProfile=join(root,"protected"), passwordFile=join(root,"primary-password");
    await mkdir(protectedProfile); await writeFile(passwordFile,"primary-test-password\n",{mode:0o600});
    const protectedInit=Bun.spawnSync(["certutil","-N","-f",passwordFile,"-d",`sql:${protectedProfile}`],{stdout:"pipe",stderr:"pipe"}); expect(protectedInit.exitCode).toBe(0);
    const encryptProtected=(value:string)=>{const result=Bun.spawnSync([binary,`sql:${protectedProfile}`,value,"primary-test-password"],{stdout:"pipe",stderr:"pipe"});if(result.exitCode!==0)throw new Error(`Protected NSS fixture failed: ${result.exitCode}`);return result.stdout.toString("base64");};
    await writeFile(join(protectedProfile,"logins.json"),JSON.stringify({logins:[{hostname:"imap://imap.example.test",encryptedUsername:encryptProtected("incoming"),encryptedPassword:encryptProtected("imap-secret")},{hostname:"smtp://smtp.example.test",encryptedUsername:encryptProtected("outgoing"),encryptedPassword:encryptProtected("smtp-secret")}]}));
    await expect(readThunderbirdCredentials(protectedProfile,account,"")).rejects.toMatchObject({reason:"locked"});
    expect(await readThunderbirdCredentials(protectedProfile,account,"primary-test-password")).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"});

    const thunderbirdRoot=join(root,".thunderbird"); await mkdir(thunderbirdRoot);
    await writeFile(join(thunderbirdRoot,"profiles.ini"),`[Profile0]\nName=test\nIsRelative=0\nPath=${profile}\n`);
    await writeFile(join(profile,"prefs.js"),[
      ['mail.accountmanager.accounts','account1'],['mail.account.account1.server','server1'],['mail.account.account1.identities','id1'],['mail.server.server1.type','imap'],['mail.server.server1.hostname','imap.example.test'],['mail.server.server1.socketType',3],['mail.server.server1.userName','incoming'],['mail.identity.id1.useremail','berk@berkderooij.nl'],['mail.identity.id1.smtpServer','smtp1'],['mail.smtpserver.smtp1.hostname','smtp.example.test'],['mail.smtpserver.smtp1.try_ssl',3],['mail.smtpserver.smtp1.username','outgoing'],['mail.smtpserver.smtp1.authMethod',3]
    ].map(([key,value])=>`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
    const {createServer}=await import("node:net"); const probe=createServer(); await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));
    const bound=probe.address(); if (!bound || typeof bound==="string") throw new Error("Cannot allocate port"); const port=bound.port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
    const compiledExecutable=process.env.POSTMOTE_TEST_BINARY;
    const child=Bun.spawn(compiledExecutable ? [compiledExecutable,"serve"] : [process.execPath,"src/main.ts","serve"],{env:{...process.env,HOME:root,POSTMOTE_DATA_DIR:join(root,"data"),POSTMOTE_PORT:String(port)},stdout:"ignore",stderr:"ignore"});
    try {
      const base=`http://127.0.0.1:${port}`;
      for (let i=0;;i++){try{if((await fetch(base+"/api/health")).ok)break}catch{} if(i===100)throw new Error("Daemon did not start");await Bun.sleep(50)}
      const json={"content-type":"application/json"};
      await fetch(base+"/api/setup/initialize",{method:"POST",headers:json,body:JSON.stringify({password:"synthetic owner password"})});
      const login=await fetch(base+"/api/auth/login",{method:"POST",headers:json,body:JSON.stringify({password:"synthetic owner password"})});
      const headers={...json,cookie:login.headers.get("set-cookie")!};
      const request={profileIndex:0,accountIndex:0,email:"berk@berkderooij.nl"};
      expect((await fetch(base+"/api/thunderbird/import",{method:"POST",headers:json,body:JSON.stringify(request)})).status).toBe(401);
      const wrong=await fetch(base+"/api/thunderbird/import",{method:"POST",headers,body:JSON.stringify({...request,primaryPassword:"wrong"})}); expect(wrong.status).toBe(400);
      const imported=await fetch(base+"/api/thunderbird/import",{method:"POST",headers,body:JSON.stringify(request)}); expect(imported.status).toBe(201);
      const created=await imported.json() as {id:string};
      expect(JSON.stringify(created)).not.toContain("secret");
      expect((await fetch(base+"/api/thunderbird/import",{method:"POST",headers,body:JSON.stringify(request)})).status).toBe(409);
      const { Database }=await import("bun:sqlite"), { decryptSecret }=await import("../src/vault.ts");
      const db=new Database(join(root,"data","postmote.db"),{readonly:true});
      try { const row=db.query("SELECT encrypted_secret FROM mailboxes WHERE id=?").get(created.id) as {encrypted_secret:string}; expect(row.encrypted_secret).not.toContain("secret"); expect(JSON.parse(await decryptSecret(join(root,"data"),created.id,row.encrypted_secret))).toEqual({imapPassword:"imap-secret",smtpPassword:"smtp-secret"}); } finally { db.close(); }
    } finally { child.kill(); await child.exited; }
  } finally { await rm(root,{recursive:true,force:true}); }
});
