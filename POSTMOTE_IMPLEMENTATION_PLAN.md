# Postmote — Complete Implementation Plan

**Status:** Implementation-ready specification  
**Version:** 1.2 single-executable baseline (Postmote naming)  
**Date:** 2026-10-22  
**Target:** A minimal, secure, fast, local-first email bridge for Codex, OMP, and any MCP-compatible coding agent.

## 0. Locked decisions

**Canonical product naming:** Postmote (product), `postmote` / `postmote.exe` (executable), `postmote` (local daemon), `postmote://` (MCP resources), `POSTMOTE_` (environment variables), `postmote.db` (database). Do not ship legacy product names or commands. CLI is `postmote mcp stdio` (not `postmote mcp-stdio`).

| Area | Decision |
|---|---|
| Runtime | **Bun compiled runtime**, strict TypeScript / Node-compatible APIs; no runtime installation |
| Deployment | **One downloadable executable** per OS/architecture; local daemon bound to `127.0.0.1`, plus built-in `mcp stdio` forwarding mode |
| Incoming mail | On-demand IMAP fetch plus scheduled polling; **no IMAP IDLE**, push service, or webhook dependency |
| Outgoing mail | **Explicit human approval for every SMTP send**; approval cannot be delegated to the agent |
| Reuse | Prefer official SDK and maintained mail libraries; audit existing implementations before borrowing code |
| Persistence | SQLite with WAL; encrypted secret values; no Redis/Postgres |
| UI | Minimal Preact UI compiled into the executable; served over localhost; no separately installed frontend |
| Agent transports | MCP Streamable HTTP on loopback; stdio proxy/adapter for clients requiring stdio |
| Authentication | Local dashboard owner session; separately scoped agent tokens |
| v1 scope | IMAP/SMTP credentials, read/search/organize mail, draft/reply/forward, approval queue, attachment handling, multi-account, Codex/OMP setup |


## 0A. Single-binary release contract (takes precedence over later packaging details)

**One-file distribution is a hard requirement.** Users download `postmote` (or `postmote.exe`) and run it directly. The executable contains the Bun runtime, application, official MCP SDK, mail client libraries, embedded dashboard, schema migrations, and CLI help. No Node.js, Bun, npm, Docker, database server, or frontend build is required on the user's machine. Application-generated state lives outside the executable.

### CLI user journey

```bash
# Install: download the release appropriate for your OS/architecture,
# verify published checksum, then place the executable on PATH.
postmote --version
postmote init                 # first-run wizard, create local vault key and owner credentials
postmote serve                # start local UI and MCP HTTP endpoint
postmote doctor               # diagnostic checks, redacted output only
postmote mcp stdio            # forwards MCP stdio to the local daemon; no second mail engine
postmote config show          # redacted config and local locations
```

On first run, open or print `http://127.0.0.1:3145/` with a one-time owner setup flow. `serve` is foreground by default; optional OS-native autostart/service integration is post-v1 and must not introduce background processes without user consent. `init` and `serve` must provide clear errors and exit codes. If the daemon is not already running, stdio forwarding should fail with a precise startup instruction; do **not** secretly start a second daemon.

### Build and distribution

Use Bun's documented single-file compilation (`bun build --compile`). Build the frontend first; embed the immutable HTML/CSS/JS and SQL migrations as build assets. Produce platform-specific executables and do not rely on cross-compilation alone as proof of runtime compatibility. Representative build (entrypoint and flags must be confirmed on pinned Bun release):

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build:web
bun build ./src/main.ts --compile --minify --target=bun-linux-x64 --outfile dist/postmote-linux-x64
./dist/postmote-linux-x64 --version
```

Support Linux x64 and arm64, macOS Apple Silicon and Intel, and Windows x64 where verified. Linux musl builds may be added after testing. Output a SHA-256 manifest and reproducible source/tag metadata. Codesign/notarize macOS artifacts and sign Windows artifacts when release infrastructure permits; document any unsigned development artifacts. No external DLL, npm dependency, or bundled browser required.

### Data and isolation

- OS-specific application data directory: Linux `${XDG_DATA_HOME:-~/.local/share}/postmote`, macOS `~/Library/Application Support/Postmote`, Windows `%LOCALAPPDATA%\Postmote`; override with `POSTMOTE_DATA_DIR`. Never store secrets or SQLite files beside the executable or in the current working directory by default.
- Config, `postmote.db`, SQLite WAL/SHM, attachments cache, and vault key material are **runtime data files**, not additional application binaries. Clarify this distinction in documentation.
- File permissions: owner-only directory/files on POSIX; Windows user ACLs. Key material must be separated from encrypted database values. Prefer OS secret store where feasible, or an owner-supplied passphrase with a documented unlock model; never generate a plaintext unlock key beside encrypted credentials and call it secure.
- Enforce one daemon instance per data directory, database migrations transactionally, lock contention handling, and clean shutdown.

### Performance budget and feasibility gate

- Goals (not guaranteed measurements): cold CLI startup under 500 ms, steady-state idle memory under 80 MiB with one configured account and polling inactive, and no periodic polling more frequent than 60 seconds by default. Measure on representative Linux/macOS/Windows hosts.
- Measure final disk size rather than claiming a number: Bun embeds a full runtime; compiled executables may be tens of MB, not tiny native binaries. Compare cold start, idle RSS, release size, and package compatibility in CI.
- **Hard gate:** ImapFlow, Nodemailer, MailParser, and MCP SDK must pass a real TLS IMAP/SMTP integration suite from the compiled executable. Include multipart MIME, attachments, STARTTLS, strict certificate verification, reconnects, failed auth, and long-lived polling.
- If Bun compile compatibility or actual memory budgets fail, document the failure and propose a Rust-native implementation as a separate architectural decision; do not silently ship multiple files or replace functionality. Rust is the path to a materially smaller native executable, but increases implementation effort and may require swapping mail libraries.

### Automated release acceptance tests

1. Download fresh binary on a clean machine/container without Node/Bun; verify `--version`, `init`, `doctor`, and `serve`.
2. Embedded dashboard loads without external CSS/JS/font/network dependencies; local browser login and adding a mailbox work.
3. Codex and OMP can invoke the same MCP endpoint; `mcp stdio` forwards instead of creating a second mailbox worker.
4. IMAP polling survives process restart; no duplicate canonical UID records; incoming mail is visible to MCP.
5. Agent send requests stay `PENDING_APPROVAL`; only authenticated dashboard owner approval results in one SMTP submission, including crash/retry scenarios.
6. No plaintext credentials in logs, executable build constants, MCP results, crash reports, or command history.
7. Release binaries are scanned for unexpected runtime file dependencies; hashes match release manifest.

**Upstream source:** https://bun.sh/docs/bundler/executables (single-file compilation and embedded full-stack assets).

### Non-goals

Do not build an SMTP server, IMAP server, webmail replacement, cloud SaaS, multi-user enterprise IAM, autonomous agent runtime, email provider, workflow scripting language, or always-on unsolicited agent wakeup service. OAuth provider sign-in can be a follow-on adapter; v1 must support conventional app-password and account/password IMAP/SMTP with TLS. No remote network binding in v1.

## 1. Source-of-truth upstream references

- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/ — official stable 2026-07-28 specification implementation. Packages `@modelcontextprotocol/server` and transport adapters.
- MCP Server package: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/
- Streamable HTTP: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/node/streamableHttp.html
- ImapFlow: https://imapflow.com/ and https://github.com/postalsys/imapflow
- Nodemailer: https://nodemailer.com/ and https://github.com/nodemailer/nodemailer
- MailParser: https://nodemailer.com/extras/mailparser/ and https://github.com/nodemailer/mailparser
- OMP MCP configuration: https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md
- Codex MCP documentation: https://developers.openai.com/codex/mcp/
- Existing implementations for review: https://github.com/nikolausm/imap-mcp-server and https://github.com/yunfeizhu/mcp-mail-server

**Verification rule:** Before implementation, validate exact packages, package exports, versions, and agent config formats against installed/upstream code. Do not paste outdated v1 MCP SDK samples. Audit library licenses, maintenance, transitive dependencies, and security issues; do not assume that existing mail MCP servers are safe to vendor. Reuse libraries first, borrow application code only when its license and threat model are acceptable.

## 2. System architecture

```text
Codex / OMP / other agents
       | MCP Streamable HTTP (127.0.0.1:3145/mcp; scoped token)
       | OR stdio shim (connects to same daemon with scoped token)
       v
Postmote daemon — one compiled Bun executable
  +-- MCP handlers / schema validation
  +-- authorization (agent -> mailbox -> operation)
  +-- mailbox service (IMAP search, fetch, folders, flags)
  +-- message service (MIME, threading, attachments)
  +-- outgoing service (draft, preview, approval, SMTP)
  +-- polling scheduler (per-mailbox interval, backoff, reconciliation)
  +-- SQLite (metadata, policies, approval queue, audit, cursors)
  +-- encrypted credential vault (separate master key)
  +-- Hono local API + Preact static dashboard
       |
       +---- IMAP (TLS) <--- external mail host
       +---- SMTP (TLS) ---> external mail host
```

The **daemon owns state and credentials**; adapters are thin. Stdio sessions must not start an independent IMAP poller or a second SQLite writer. Treat the dashboard and MCP endpoints as separate trust boundaries, even though they share one port. Bind `127.0.0.1` explicitly; reject non-loopback access; validate HTTP `Origin` and `Host` to prevent DNS rebinding. Never depend on CORS as an authentication control.

### Core interfaces

```ts
interface MailProvider {
  testConnection(accountId: string): Promise<ConnectionTest>;
  listFolders(accountId: string): Promise<Folder[]>;
  listMessages(input: MailListInput): Promise<Page<MessageSummary>>;
  getMessage(input: MessageReference): Promise<MailMessage>;
  search(input: MailSearchInput): Promise<Page<MessageSummary>>;
  updateFlags(input: FlagUpdate): Promise<void>;
  move(input: MoveRequest): Promise<MessageReference>;
  delete(input: DeleteRequest): Promise<void>;
  fetchAttachment(input: AttachmentReference): Promise<AttachmentStream>;
}
interface OutboxService {
  prepare(input: ComposeRequest, principal: Principal): Promise<PendingSend>;
  approve(id: string, ownerSession: OwnerSession): Promise<SendResult>;
  reject(id: string, ownerSession: OwnerSession, reason?: string): Promise<void>;
  status(id: string, principal: Principal): Promise<SendStatus>;
}
interface AgentPolicy {
  authorize(principal: Principal, accountId: string, capability: Capability): void;
  validateRecipients(principal: Principal, recipients: string[]): void;
}
```

Keep all MCP transport logic outside these interfaces to make mail behavior unit-testable.

## 3. Configuration and data model

### Configuration

```env
POSTMOTE_BIND=127.0.0.1
POSTMOTE_PORT=3145
POSTMOTE_DATA_DIR=~/.local/share/postmote
POSTMOTE_MASTER_KEY_FILE=/path/to/private/master-key
POSTMOTE_LOG_LEVEL=info
POSTMOTE_DEFAULT_POLL_SECONDS=120
POSTMOTE_MAX_MESSAGE_BYTES=26214400
POSTMOTE_MAX_ATTACHMENT_BYTES=10485760
POSTMOTE_MAX_SENDS_PER_HOUR=30
```

Default intervals: 120 seconds; configurable 60–3600 seconds. Add randomized jitter and exponential backoff for failed connections. Reject invalid env options at startup. Generate master key at initialization using a CSPRNG; enforce restrictive permissions (directories 0700; key/database 0600 where OS supports). Prefer an OS keychain backend when available; a key file is the portable fallback. Never record the key or mailbox secrets in application logs.

### SQLite tables (mandatory)

- `schema_migrations(version, applied_at)`
- `mailboxes(id, label, email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, encrypted_secret, auth_kind, poll_seconds, status, created_at, updated_at)`
- `agents(id, label, token_hash, token_prefix, enabled, created_at, last_used_at)`
- `agent_mailbox_grants(agent_id, mailbox_id, capability, created_at)` with unique grant constraint
- `folder_state(mailbox_id, folder_path, uidvalidity, highest_uid, last_sync_at, last_error)`
- `message_index(mailbox_id, folder_path, uidvalidity, uid, internet_message_id, thread_parent_id, from_json, to_json, subject, internal_date, flags_json, snippet, size_bytes)` with UNIQUE `(mailbox_id, folder_path, uidvalidity, uid)`
- `drafts(id, mailbox_id, agent_id, mime_fields_json, encrypted_body_or_reference, revision, created_at, updated_at)`
- `send_requests(id, mailbox_id, agent_id, draft_id, draft_revision, approved_payload_hash, state, approval_expires_at, approved_at, smtp_started_at, smtp_result_json, idempotency_key, created_at, updated_at)`
- `audit_events(id, time, principal_type, principal_id, mailbox_id, action, target_id, outcome, detail_json)`
- `owner_sessions(id_hash, issued_at, expires_at, revoked_at)`

Provide migrations from day one. Use prepared statements, foreign keys ON, WAL mode, busy timeout, checkpointing, and size-limited retention. Credentials and draft bodies should be encrypted at rest; never store inbound HTML or attachment blobs by default. Index `(mailbox_id, folder_path, internal_date)` and `internet_message_id`.

### Stable message identity

Use `mailbox_id + folder_path + UIDVALIDITY + UID` as canonical IMAP identity. RFC `Message-ID` is useful for threads, but is not guaranteed unique or even present. Detect changed UIDVALIDITY and rebuild only that folder index. Use immutable server IDs in MCP tool outputs. A move may change a message UID, so return the updated reference when available. Avoid claiming exactly-once polling events.

## 4. Add Mailbox UI: complete form and validation

### Page and interaction design

Route: `/mailboxes/new`. Page title: **Add mailbox**. Single compact multi-section form; advanced settings are collapsed by default. Keyboard accessible, with explicit labels, visible focus, `aria-describedby` inline errors, no invisible error-only validation. Never prefill real credentials from another mailbox.

**Section A — Identity:** display label (optional, <=80 chars), email address (required, <=254), optional sender display name (<=100). Display label defaults to email; sender name defaults to empty.

**Section B — Incoming / IMAP:** host (required; DNS hostname or IP), port (default 993), encryption mode `TLS` or `STARTTLS` (default TLS), username (required), password/app password (required), mailbox root (optional; default auto-discover), polling interval (default 120s). Explicitly no `NONE`/plaintext selection.

**Section C — Outgoing / SMTP:** host (required), port (default 465 for TLS, 587 for STARTTLS), encryption mode `TLS` or `STARTTLS`, username (required, optional **Use IMAP username** checkbox), password (required, optional **Use IMAP password** checkbox), sender email (defaults to account email; verified/policy checked server-side). SMTP can be marked disabled for read-only accounts; sending tools then refuse with `SMTP_NOT_CONFIGURED`.

**Section D — Permissions:** optional initial agent grants. Default **no agent access**, grants added explicitly. Show read/search/draft/reply/send-request/organize/delete/attachments separately. Every new mailbox defaults to `send approval required`, globally immutable in v1.

**Section E — Review and test:** masked credential summary; **Test IMAP**, **Test SMTP**, **Save mailbox** controls; connection test reports hostname, TLS and authentication stage without logging credentials; successful test is valid only for the exact current form values. Saving may proceed with a documented warning for temporarily unreachable servers, but never bypass local syntax/TLS-mode validation. Agent grants apply only after successful database commit.

### Form validation matrix

| Field | Client validation | Server validation |
|---|---|---|
| Label | trim; 1–80 if supplied | Unicode normalization, length and control-character rejection |
| Email / sender email | syntactically valid addr-spec, <=254 bytes | robust email parser; no CR/LF injection; sender address checked against policy |
| IMAP/SMTP host | required, <=253 chars, hostname/IP | reject URL schemes, paths, userinfo, whitespace, CR/LF, NUL; normalize IDNA; DNS resolution checked at connection |
| Port | integer 1–65535 | same, refuse unsafe configurations; defaults match TLS mode |
| Encryption mode | enum `tls`/`starttls` | TLS certificate and hostname verification mandatory; STARTTLS must be advertised and completed |
| Usernames | 1–320 chars | control characters rejected; no log exposure |
| Password | nonempty, capped at safe configured max | accept special characters; never trim silently; encrypt before persistence |
| Poll interval | integer 60–3600 seconds | enforce range; backoff independent of interval |
| Folder root | optional <=512 | reject control chars; treat as mailbox path, never filesystem path |
| Initial agent grants | known agent IDs and capability enums | authorization checked against authenticated owner, foreign keys, whitelist |
| Test connection | disable when invalid; cancel stale results | bounded timeouts, TLS strict, distinguish DNS/TCP/TLS/auth errors without disclosing secrets |

Do **not** hardcode an email-domain allowlist. For local self-hosted deployments, hostnames resolving to local or private IPs may be legitimate; protect connection targets with explicit per-account owner consent, avoid redirects, never treat hostnames as URLs, and revalidate TLS identities. Do not send credentials to a server other than the explicitly configured mail host. Never automatically use a lower-security mode after TLS failure.

### States and behavior

`empty -> editing -> validating -> testing_imap/testing_smtp -> ready -> saving -> created`; failure returns to editing with persistent values (password remains only in transient component memory, not localStorage). Changes invalidate test results. Duplicate exact email+host pairs trigger an owner confirmation, not an accidental overwrite. Back navigation asks before discarding changes. Buttons show loading, avoid duplicate submissions, and provide actionable errors. Test requests must be rate-limited. UI must not expose raw TLS stack traces.

## 5. MCP contract

### Protocol and transport

Implement MCP SDK v2 tools, resources, prompts and stdio + Streamable HTTP. Instantiate agent principal from a validated bearer token or stdio bridge credential, **never** from a model-supplied `agent_id`. `/mcp` is separate from `/api` and `/app`. Require `Authorization: Bearer <token>` for HTTP, check origin and host, do not bind beyond loopback. Stdio shim obtains its token via environment or protected token file and connects to daemon; logs go to stderr only. No secrets are emitted into stdout.

### Common input definitions (JSON Schema draft 2020-12 shorthand)

All tool argument objects use `additionalProperties:false`. Every `mailboxId` must reference an account authorized to the principal. IDs are opaque strings generated server-side. `message` references contain exactly `{mailboxId, folder, uidValidity, uid}`. Output envelope returns `{ok:true,data:{...}}` or `{ok:false,error:{code,message,retryable,details?}}`; redact internal stack traces and secrets. Enforce tool outputs under configurable byte and result caps.

```json
{
  "$defs": {
    "mailboxId": {"type":"string","minLength":1,"maxLength":128},
    "folder": {"type":"string","minLength":1,"maxLength":512},
    "uidValidity": {"type":"integer","minimum":1},
    "uid": {"type":"integer","minimum":1},
    "messageRef": {"type":"object","additionalProperties":false,"required":["mailboxId","folder","uidValidity","uid"],"properties":{"mailboxId":{"$ref":"#/$defs/mailboxId"},"folder":{"$ref":"#/$defs/folder"},"uidValidity":{"$ref":"#/$defs/uidValidity"},"uid":{"$ref":"#/$defs/uid"}}},
    "address": {"type":"string","minLength":3,"maxLength":254},
    "addresses": {"type":"array","items":{"$ref":"#/$defs/address"},"minItems":1,"maxItems":100},
    "pageSize": {"type":"integer","minimum":1,"maximum":100,"default":25},
    "cursor": {"type":"string","maxLength":1024},
    "text": {"type":"string","maxLength":1000000},
    "id": {"type":"string","minLength":1,"maxLength":128},
    "attachmentId": {"type":"string","minLength":1,"maxLength":256}
  }
}
```

### Tools: exact input and expected output contracts

Notation: fields with `?` are optional; all others required. Compile these specifications into actual Zod v4 schemas and generated JSON Schema, with `additionalProperties:false`; the table below is the normative per-tool field list. All string bounds and enum validation apply server-side.

| Tool | Input object | Output `data` object | Capability |
|---|---|---|---|
| `mail_accounts` | `{}` | `{accounts:[{id,label,email,imapStatus,smtpEnabled,unreadCount}]}` | any assigned capability |
| `mail_status` | `{mailboxId}` | `{imap:{connected,lastPollAt,lastError},smtpEnabled,unreadCount,nextPollAt}` | `mail.read` |
| `mail_folders` | `{mailboxId}` | `{folders:[{path,name,flags,total,unread}]}` | `mail.read` |
| `mail_list` | `{mailboxId,folder?,pageSize?,cursor?,unreadOnly?}` | `{messages:MessageSummary[],nextCursor?:string}` | `mail.read` |
| `mail_get` | `{message:MessageRef,bodyFormat?:"text"|"html"|"both",includeHeaders?:boolean}` | `{message:MailMessage}` | `mail.read` |
| `mail_search` | `{mailboxId,folder?,query?:string,from?:string,to?:string,subject?:string,after?:ISODate,before?:ISODate,hasAttachment?:boolean,unreadOnly?:boolean,pageSize?,cursor?}` | `{messages:MessageSummary[],nextCursor?:string,searchMode:"server"|"indexed"}` | `mail.search` |
| `mail_attachment_info` | `{message:MessageRef,attachmentId}` | `{filename,mimeType,sizeBytes,disposition}` | `mail.attachments` |
| `mail_attachment_read` | `{message:MessageRef,attachmentId,offset?:integer,length?:integer}` | `{mimeType,filename,dataBase64,truncated,offset,totalBytes}` | `mail.attachments` |
| `mail_draft_create` | `{mailboxId,to:string[],cc?:string[],bcc?:string[],subject:string,text?:string,html?:string,inReplyTo?:MessageRef,attachments?:AttachmentHandle[]}` | `{draftId,revision,preview}` | `mail.draft` |
| `mail_draft_update` | `{draftId,expectedRevision,patch:ComposePatch}` | `{draftId,revision,preview}` | `mail.draft` |
| `mail_draft_get` | `{draftId}` | `{draftId,revision,compose}` | `mail.draft` |
| `mail_draft_delete` | `{draftId}` | `{deleted:true}` | `mail.draft` |
| `mail_send_request` | `{draftId,expectedRevision,idempotencyKey}` | `{requestId,state:"pending_approval",preview,expiresAt}` | `mail.send.request` |
| `mail_send_status` | `{requestId}` | `{requestId,state,queuedAt,approvedAt?,sentAt?,smtpMessageId?,error?}` | `mail.send.request` |
| `mail_reply_draft` | `{message:MessageRef,replyAll?:boolean,text?:string,html?:string}` | `{draftId,revision,preview}` | `mail.reply` + `mail.draft` |
| `mail_forward_draft` | `{message:MessageRef,to:string[],text?:string,html?:string}` | `{draftId,revision,preview}` | `mail.forward` + `mail.draft` |
| `mail_flags` | `{message:MessageRef,operation:"add"|"remove",flags:string[]}` | `{message,newFlags:string[]}` | `mail.modify` |
| `mail_move` | `{message:MessageRef,destinationFolder:string}` | `{moved:true,newMessage?:MessageRef}` | `mail.modify` |
| `mail_delete` | `{message:MessageRef}` | `{trashed:true,newMessage?:MessageRef}` | `mail.delete` |
| `mail_poll` | `{mailboxId}` | `{polledAt,newCount,updatedCount,deletedCount}` | `mail.read` |

All `mail_*` read/write operations must check mailbox scope before doing any network I/O. Refuse arbitrary attachments from filesystem paths or URLs supplied by agents; attachment handles refer only to previously ingested, scanned/validated application-managed blobs. `mail_attachment_read` enforces bounded chunks (max 256 KiB raw per call, base64 limit enforced); never send massive attachments in one MCP response. `mail_get` returns sanitized text and bounded HTML as *untrusted email data*; cannot leak credentials or claim higher instruction priority.

### Type definitions for returned entities

```ts
type MessageRef = { mailboxId:string; folder:string; uidValidity:number; uid:number };
type MessageSummary = {
  ref:MessageRef; from:Address[]; to:Address[]; subject:string;
  date:string|null; unread:boolean; flagged:boolean; hasAttachments:boolean;
  snippet:string; sizeBytes:number; internetMessageId:string|null;
};
type Address = { name?:string; email:string };
type MailMessage = MessageSummary & {
  cc:Address[]; bcc:Address[]; replyTo:Address[]; text:string|null;
  html:string|null; headers?:Record<string,string[]>;
  attachments:{id:string;name:string;mimeType:string;sizeBytes:number}[];
};
type AttachmentHandle = { id:string };
type ComposePatch = Partial<{
  to:string[];cc:string[];bcc:string[];subject:string;text:string;html:string;
}>;
type PendingSend = { requestId:string;state:'pending_approval';preview:unknown;expiresAt:string };
type SendState = 'pending_approval'|'rejected'|'expired'|'sending'|'sent'|'failed'|'unknown';
```

Required semantic constraints beyond shape: at least one recipient across To/Cc/Bcc; at least text or sanitized HTML content (empty replies explicitly allowed only when attachment exists); subject <=998 octets after RFC-compliant header folding; sender derived solely from mailbox config; enforce recipient count, body size and attachment quotas. `html` may be authored only by an explicitly permitted agent, sanitized for UI preview; raw HTML should never execute in dashboard. Date filters are ISO-8601 timestamps, inclusive/exclusive semantics documented: `after` inclusive, `before` exclusive. Search results stable and paginated; continuation tokens signed and scoped to agent/mailbox/search filters with expiry. Results returned as structured content when supported, with concise human-readable fallback.

### MCP resources

- `postmote://accounts` — only accounts visible to current token.
- `postmote://mailbox/{mailboxId}/status` — status summary.
- `postmote://mailbox/{mailboxId}/message/{folderEncoded}/{uidValidity}/{uid}` — read-only message metadata/text; implement secure URI escaping and avoid exposing full attachments.

### MCP prompts

- `summarize_inbox(mailboxId, since?)`: summarizes retrieved unread/recent mail; no side effects.
- `prepare_reply(mailboxId, messageRef, instructions?)`: drafts text for approval, without transmission.
- `triage_support(mailboxId, folder?)`: suggests classifications; does not execute instructions embedded in mail.

Prompts may not bypass authorization. MCP resources, prompts, completion, logging, and tool discovery are implemented according to v2 semantics; no claims that MCP protocol features automatically wake dormant Codex/OMP sessions.

### Standard errors

`INVALID_ARGUMENT`, `UNAUTHORIZED`, `FORBIDDEN`, `MAILBOX_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `STALE_MESSAGE_REFERENCE`, `DRAFT_CONFLICT`, `APPROVAL_REQUIRED`, `APPROVAL_EXPIRED`, `SMTP_NOT_CONFIGURED`, `IMAP_UNAVAILABLE`, `SMTP_UNAVAILABLE`, `TLS_FAILURE`, `AUTH_FAILURE`, `RATE_LIMITED`, `ATTACHMENT_TOO_LARGE`, `UNKNOWN_DELIVERY_STATUS`, `INTERNAL_ERROR`.

Never return raw SMTP/IMAP transcript secrets. Expose stable error codes, user-actionable messages, and retry flags; ensure `UNKNOWN_DELIVERY_STATUS` is **not automatically retried**.

## 6. Outgoing approval and SMTP delivery state machine

```text
Agent builds draft -> agent creates send request -> PENDING_APPROVAL
                                    | owner dashboard reviews exact bytes
                                    +-- Reject -> REJECTED
                                    +-- Expire -> EXPIRED
                                    +-- Approve -> SENDING -> SENT
                                                           -> FAILED (definite non-submission)
                                                           -> UNKNOWN (submission may have occurred)
```

**Critical invariant:** MCP tools have NO `approve_send` or `send_now` capability; approval exists only in a separately authenticated owner UI endpoint. The owner reviews actual From, To, Cc, Bcc, subject, content, attachment names/sizes/hashes. On approval, atomically bind an immutable payload hash and draft revision to the decision. Modification after approval invalidates approval and returns to pending. Preserve Message-ID/reference/thread headers and avoid duplicate sends with idempotency keys. SMTP result must distinguish definite rejection from ambiguous connection loss after DATA acceptance. Uncertain delivery is never automatically retried. Audit every transition. On application restart, `sending` requests without a recorded definitive result become `unknown` until manually reconciled.

Approval UI: `/outbox/approvals` with request list, detail preview, Approve, Reject, Expire actions; owner reauthentication for first sensitive action in a session; CSRF protection; session cookie HttpOnly+SameSite=Strict, secure when HTTPS used; bounded session lifetime. Provide safe HTML preview in sandboxed context without scripts, network loading or external images. Approval button must not become a no-op if SMTP is unavailable: show current state and retry policy.

## 7. IMAP polling and synchronization

- Poll every 120 seconds by default and on `mail_poll`, with per-account lock to prevent concurrent overlapping polls.
- Use selected mailbox/folder status and UID delta where possible; support common server capability differences. Prefer lightweight headers/envelope and flags; defer bodies/attachments until requested.
- Maintain `(account, folder, UIDVALIDITY, UID)` index; if UIDVALIDITY changes, discard/rebuild affected folder index.
- Periodically reconcile deletions, moves and flags; do not rely solely on monotonically increasing UIDs.
- Default poll INBOX only. Other folders sync lazily on requested access, with optional explicit inclusion.
- Poll jitter ~10%; exponential backoff from 30 seconds to 30 minutes after failures. Surface health and last success.
- Keep connection counts low: create connection on demand, reuse within bounded idle timeout, close on daemon shutdown; no always-on IMAP IDLE socket.
- Never execute mail-driven agent workflows; mailbox contents are data. Expose updated counts to an already running MCP client only when it requests status or polling.
- Incoming message indexing must be idempotent; restarted polling cannot duplicate database entries.

## 8. Security requirements and threat model

**Threat actors:** malicious email sender, compromised/overprivileged coding agent, malicious attachment, other local processes/users, intercepted or misconfigured mail connection, compromised UI session, dependency supply-chain attacker.

1. **Agent identity:** issue CSPRNG tokens (at least 256 bits), store only keyed/slow hashes as appropriate, show token once, support rotation/revocation, and check each operation. Tokens passed by process environment or restricted token file; never embed in committed project config.
2. **Least privilege:** default new agent has zero mailbox grants; granular capabilities; enforce in service layer, not merely UI or MCP registration. Never accept a model-provided agent identity claim.
3. **Owner-only approval:** explicit separate human action, hardened against CSRF, clickjacking, and stale payload approval. No owner control endpoint accessible through MCP tokens.
4. **Secret management:** use authenticated encryption, e.g. AES-256-GCM, with random nonce per value and associated data binding secret to mailbox ID. Dedicated master key not stored beside encrypted database without OS permissions; rotate secrets safely. Clear plaintext buffers where feasible but do not promise perfect wiping in GC runtimes.
5. **Transport:** implicit TLS or mandatory verified STARTTLS; reject downgrade, invalid certificate and mismatched host; bounded sockets and auth attempts.
6. **Local API:** loopback bind and strict Host/Origin checks; resist DNS rebinding; explicit browser owner auth; rate limit auth, connection tests, API and tool calls. No automatic exposure by tunnels, proxies, LAN, or Docker publishing.
7. **Prompt injection:** email body, headers and attachments always untrusted, never system/developer instructions; label mail content in tool results. No automatic shell execution, web fetch, filesystem traversal or instructions from email. Incoming emails cannot authorize sending.
8. **Attachment security:** prohibit arbitrary local file reads; bounded streaming/temp files under private data dir; MIME and extension checks, max sizes, safe filenames, no active content rendering, no automatic external fetch. Antivirus integration optional, but user-visible risk warnings are required.
9. **Logging/privacy:** structured logs, redact recipient/body content by default, never log passwords/tokens/email bodies/raw headers/authorization. Audit action type, IDs and outcomes; optional configurable retention.
10. **Availability:** command/socket timeouts, operation cancellation, mailbox/server concurrency limits, bounded MCP response sizes, transaction boundaries, SQLite integrity backups, graceful shutdown.
11. **Provider SMTP constraints:** address spoofing checked by configured sender identity; refuse unauthenticated relay or implicit fallback to alternate host; preserve sender/reply-to according to approved exact payload.
12. **Dependencies:** lockfile, CI dependency scanning, license review, pin releases, no `npm install` code copied from arbitrary README without review.

## 9. Dashboard navigation and owner API

Navigation: Overview, Mailboxes, Agents, Inbox (read-only convenience), Drafts, Approvals, Activity, Settings.

Owner endpoints (all under `/api`, session authenticated):

- `POST /api/setup/initialize` (first-run local-only owner setup)
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET/POST /api/mailboxes`, `GET/PATCH/DELETE /api/mailboxes/:id`
- `POST /api/mailboxes/test-imap`, `POST /api/mailboxes/test-smtp`
- `GET/POST /api/agents`, `PATCH/DELETE /api/agents/:id`, `POST /api/agents/:id/rotate-token`
- `GET/PUT /api/agents/:id/grants`
- `GET /api/outbox/approvals`, `GET /api/outbox/approvals/:id`
- `POST /api/outbox/approvals/:id/approve`, `POST /api/outbox/approvals/:id/reject`
- `GET /api/activity`, `GET /api/health`, `GET/PATCH /api/settings`

Use consistent problem-details error responses, request IDs, pagination, and schema-generated OpenAPI where practical. No owner REST endpoint should be callable with an agent token. `/api/health` exposes only non-sensitive service state without authentication; detailed account status requires owner authentication.

## 10. Repository layout

```text
postmote/
  package.json
  bun.lock
  tsconfig.json
  .env.example
  .gitignore
  README.md
  LICENSE
  scripts/build.ts          # compile standalone releases for supported platforms
  src/
    cli.ts                   # init, doctor, serve, mcp stdio, config
    daemon.ts
    config/schema.ts
    db/client.ts
    db/migrations/
    security/vault.ts
    security/auth.ts
    security/permissions.ts
    security/limits.ts
    mail/accounts.ts
    mail/imap.ts
    mail/smtp.ts
    mail/mime.ts
    mail/search.ts
    mail/poller.ts
    mail/attachments.ts
    mail/identifiers.ts
    mail/errors.ts
    outbox/drafts.ts
    outbox/approval.ts
    outbox/delivery.ts
    mcp/server.ts
    mcp/stdio-bridge.ts
    mcp/http.ts
    mcp/tools/
    mcp/resources.ts
    mcp/prompts.ts
    mcp/schemas.ts
    web/server.ts
    web/routes/
    audit/events.ts
  ui/
    index.html
    src/app.tsx
    src/routes/
    src/components/
    src/lib/api.ts
  tests/
    unit/
    integration/
    mcp/
    e2e/
    fixtures/eml/
    fixtures/certificates/
    security/
  scripts/
    dev.mjs
    smoke-test.mjs
  docs/
    architecture.md
    security.md
    mcp-contract.md
    setup-codex.md
    setup-omp.md
    troubleshooting.md
```

One executable, one persistent daemon, no npm/Node/Bun install for end users. Embed the built frontend and migrations at compile time. Avoid ORM runtimes, microservices and queues. Prefer `bun:sqlite` (built-in), subject to WAL and migration tests. Keep mail library modules compatible with Bun; test IMAPFlow, Nodemailer, MailParser and MCP SDK in a compiled executable, not just `bun run`. Use strict TypeScript, linting, unit/integration tests and optional Playwright smoke tests.

## 11. Implementation phases and exact agent tasks

### Phase 0 — Research, audit and bootstrap

- [ ] P0.1 Verify current stable Bun version, MCP v2 SDK exports, ImapFlow/Nodemailer/MailParser compatibility under Bun **and the compiled binary**, and published dependency versions.
- [ ] P0.2 Audit both cited mail MCP servers: code structure, auth, credential management, permissions, MIME handling, tests, release/license and security; record evidence in `docs/reuse-audit.md`. Do not blindly fork.
- [ ] P0.3 Choose `imapflow`, `nodemailer`, `mailparser` or equivalent after API/license/security review; define adapters.
- [ ] P0.4 Bootstrap strict TypeScript ESM project using Bun; CI for build/lint/typecheck/test and compiled-binary smoke testing.
- [ ] P0.5 Write a threat model and acceptance checklist; pin lockfile.

**Exit:** fully building skeleton, dependency audit, documented reasons for reuse choices.

### Phase 1 — State, secrets and mail core

- [ ] P1.1 Implement validated config, first-run key generation, owner setup, secret vault and rotations.
- [ ] P1.2 Create SQLite schema, migrations, indexes, idempotent transactions and backups.
- [ ] P1.3 Implement mailbox add/update/remove with exact validation matrix from §4.
- [ ] P1.4 Implement IMAP connect/test/folder discovery/search/paginated list/get/flag/move/trash.
- [ ] P1.5 Implement MIME parsing, safe body normalization, threading headers and safe attachment streaming.
- [ ] P1.6 Implement SMTP connect/test and delivery adapter; no direct sending interface exposed to agents.
- [ ] P1.7 Add deterministic fake IMAP/SMTP adapters for tests.

**Exit:** local test account can be configured; emails can be read/search/organized; SMTP test works, but all actual sending is gated.

### Phase 2 — Approval system

- [ ] P2.1 Implement editable stored drafts, revision concurrency and header normalization.
- [ ] P2.2 Implement immutable `send_requests`, idempotency keys, payload hashes and expiration.
- [ ] P2.3 Build owner-only approve/reject endpoints and delivery state machine.
- [ ] P2.4 Handle connection loss during SMTP DATA as `unknown`; block automatic replay.
- [ ] P2.5 Enforce sender/recipient limits, quotas, attachment validation and audit transitions.

**Exit:** no agent tool path can directly call SMTP; exactly one owner approval is necessary per immutable outgoing payload.

### Phase 3 — Full MCP API

- [ ] P3.1 Implement SDK v2 MCP server and structured error adapter.
- [ ] P3.2 Implement ALL 20 tools listed in §5, with strict Zod schemas and bounded outputs.
- [ ] P3.3 Implement account-specific server-side permission checks for every operation.
- [ ] P3.4 Implement MCP resources, prompts and standards-compliant content results.
- [ ] P3.5 Implement loopback Streamable HTTP plus stdio bridge; validate lifecycle, errors and session handling.
- [ ] P3.6 Implement agent token generation, revocation, rotation and UI/CLI connection snippets.
- [ ] P3.7 Test generated Codex and OMP configs against installed agent versions; no assumed env substitution.

**Exit:** a permission-scoped Codex/OMP agent can list/search/read/create draft/request send; no send without human approval.

### Phase 4 — Polling, UI and operations

- [ ] P4.1 Implement periodic IMAP polling, retry/backoff, folder cursors, UIDVALIDITY changes, reconciliation and manual poll.
- [ ] P4.2 Build Add Mailbox form, progress/testing/errors and save behavior from §4.
- [ ] P4.3 Build agent permissions and secret-token one-time reveal UX.
- [ ] P4.4 Build approval queue, immutable review, approve/reject and delivery history.
- [ ] P4.5 Build inbox preview, connection status, activity and global settings.
- [ ] P4.6 Implement `postmote init`, `postmote serve`, `postmote doctor`, `postmote mcp stdio`, `postmote backup`, and supported graceful shutdown.
- [ ] P4.7 Produce setup documentation and smoke tests for common IMAP/SMTP providers.

**Exit:** complete local-first end-to-end application; no manual JSON modification required to add mailbox or agent.

### Phase 5 — QA, release and benchmark

- [ ] P5.1 Complete automated test suite below; run against local test mail servers (e.g. GreenMail/MailHog alternative with IMAP support).
- [ ] P5.2 Inspect auth/session security and prompt-injection cases; harden attachment parsing and DNS rebinding.
- [ ] P5.3 Benchmark cold startup, idle RAM, 1/5/20 accounts, polling latency, paginated search and attachment streaming; record actual figures.
- [ ] P5.4 Build self-contained native executables for Linux x64/arm64, macOS arm64/x64 and Windows x64 (where CI runners permit); produce checksums and release archives; verify extract-run, upgrade/migration and rollback without external runtime dependencies.
- [ ] P5.5 Publish versioned README, release notes, migration policy, license and dependency SBOM.

**Exit:** all acceptance tests green, no critical/high vulnerabilities without documented mitigation, benchmark report and reproducible release.

## 12. Automated test matrix

| Layer | Required cases |
|---|---|
| Unit — validation | hostname IDNA, IPv4/IPv6, malformed URL/CRLF, ports 0/65536, TLS downgrade refusal, missing passwords, invalid addresses, duplicate grants, out-of-range polling |
| Unit — auth/policy | no grant, wrong mailbox, disabled agent, expired/revoked token, unsupported scope, impersonation attempt, owner token at MCP, agent token at owner API |
| Unit — MIME | plain text, HTML, multipart/alternative, inline image, malformed MIME, missing Message-ID, Unicode headers, quoted-printable/base64, large attachment |
| Unit — identifiers | UIDVALIDITY reset, stale UID, duplicate RFC Message-ID, move UID change, cursor tampering, cursor expiry |
| Unit — outbox | draft revision mismatch, payload mutation post-approval, duplicate idempotency key, expired approval, reject, owner-only approval, SMTP ambiguous outcome |
| Integration — IMAP | connect/auth, TLS verification failure, STARTTLS refusal, list/fetch/search/flags/move/trash, deleted message, UIDVALIDITY changes, reconnect and server outage |
| Integration — SMTP | verified TLS, auth failure, SMTP reject, timeout before DATA, disconnect after DATA, recipient restrictions, approved message headers |
| Integration — SQLite | migrations, crash/restart persistence, transaction rollback, WAL concurrent reads, encrypted secrets unreadable without master key |
| Integration — MCP | initialize, list tools/resources/prompts, schema checking, stdio framing, Streamable HTTP sessions, permission checks and error shapes |
| E2E — dashboard | owner bootstrap/login, add/test/save mailbox, invalid form errors, token one-time reveal, grant editing, approval workflow, reject workflow, browser reload |
| Security | CSRF, DNS rebinding, XSS via subject/HTML, path traversal filenames, oversized MIME, secret leakage, request flood, injected email instructions |
| Regression | stale test results after form edit, duplicate send after crash, poll overlap, shutdown during fetch, multi-account isolation, SMTP credentials never returned |

Use Vitest for unit/integration; Playwright for UI E2E; disposable local IMAP/SMTP servers for protocol tests. Never send test messages through a real external account in CI. Include negative authorization assertions for **every MCP tool** (not merely a handful). Seed deterministic mail fixtures and use fake clocks for expiration/backoff tests.

### CI quality gates

- `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build:release` succeed. Each compiled release executable passes `--version`, `doctor`, `serve` and MCP smoke tests on target OS.
- All required MCP tools have schema tests, success tests, malformed-argument tests, and unauthorized-mailbox tests.
- No unhandled promise rejection, no stdout logging from stdio transport, no credentials in snapshots.
- Add static dependency audit, license inspection and minimal supply-chain checks.
- Preserve exact outgoing MIME payload binding and non-retry-on-unknown behavior across refactors.

## 13. Acceptance criteria

1. Fresh local installation launches daemon and dashboard on `127.0.0.1:3145`, with no external services except user-configured mail hosts.
2. Owner can initialize encrypted vault and configure a mailbox using UI only; invalid config is rejected with field-specific errors.
3. IMAP TLS or mandatory STARTTLS is verified; no plaintext/downgrade path exists.
4. A successful connection test does not reveal or log a password.
5. Polling detects new messages without IDLE, respects interval/backoff, and avoids duplicate indexing after restart.
6. Agent A with mailbox A grants cannot read, search, send-request from, or list mailbox B.
7. Codex and OMP connect through supported MCP transports and discover complete tool schemas.
8. Agent can read/search/list/get and draft/reply/forward within granted scope.
9. Every outbound SMTP transmission requires a distinct, authenticated human approval on an immutable reviewed payload.
10. If agent changes recipients/body after approval, old approval cannot authorize the updated payload.
11. Ambiguous SMTP outcomes are recorded as `unknown` and never replayed automatically.
12. A denied or missing MCP permission is enforced server-side with stable error codes.
13. Malicious email bodies cannot trigger owner APIs or authorize sends, and raw HTML cannot execute script in dashboard.
14. Attachments are size-limited, chunk-readable and inaccessible through arbitrary filesystem paths.
15. Revoked tokens stop working immediately; secrets remain encrypted on disk.
16. Crash/restart preserves drafts, approvals, account configuration, cursor state and audit trail.
17. Documentation contains tested setup/doctor instructions for Node, Codex and OMP.
18. Performance metrics are measured and published (targets below are NOT guarantees).

### Performance targets (measure, don't assert as fact)

- Daemon cold startup: <1 second before account network initialization.
- Idle resident memory: target <80 MiB for one active mailbox, optimize if higher.
- Local MCP parsing/auth overhead: target <20 ms p95 excluding IMAP/SMTP work.
- New-mail discovery: <= default polling interval + poll execution duration in healthy conditions.
- Standard listing returns <=100 items per request and has bounded payload size.

## 14. Client integration deliverables

### Codex

Provide a CLI command or config generator that uses the current supported `codex mcp add` shape and references a **scoped** bearer token through an environment variable, or uses the local stdio shim. Validate against current Codex and do not leak token into repository files. Sample proposed local endpoint: `http://127.0.0.1:3145/mcp`. The generator must print instructions for exporting token into the agent process environment and checking `codex mcp list`.

### OMP

Prefer OMP native user-level `~/.omp/agent/mcp.json` (or profile-specific directory) and verify installed-version transport schema. Generate a stdio bridge config if its HTTP token-header variable interpolation is not independently verified. **Example shape, not assumed ready for direct copy:**

```json
{
  "mcpServers": {
    "postmote": {
      "type": "stdio",
      "command": "postmote",
      "args": ["mcp", "stdio"]
    }
  }
}
```

The `postmote mcp stdio` adapter must have a documented secure way to select an agent token (protected local file or inherited env); reject unauthenticated operation. Test `/mcp` discovery and at least one authorized/unauthorized tool call from both Codex and OMP.

## 15. Agent execution instructions

Use these directives when assigning the plan to a coding agent:

1. Read this whole plan, then inspect upstream SDK docs and libraries; document any deviations.
2. Implement in phase order. Create small, reviewable commits; no broad refactor unrelated to acceptance criteria.
3. Implement the policy/approval boundary **before** exposing SMTP through MCP.
4. Prefer narrow adapters around proven dependencies to copied full application servers.
5. Use strict TypeScript; no `any` in exposed interfaces, no unvalidated network/config input.
6. Generate schemas from source types/validators where feasible; keep MCP docs synchronized with actual code.
7. Every new MCP tool must include allow, deny, malformed input and mailbox-isolation tests.
8. Avoid extra processes and caches until benchmark evidence justifies them.
9. Do not allow autonomous sending in v1 even if a provider or MCP client offers approval UX.
10. Never output real secrets, access tokens, mailbox contents or personal addresses in logs/test fixtures.
11. Before release, run the full suite, inspect binary and embedded asset contents, check actual UI flows and report outstanding deviations.
12. Maintain `IMPLEMENTATION_STATUS.md` containing phase checklist, evidence/test command, blockers, and next actionable task.

### Recommended first engineering task

Create the repository skeleton plus `docs/reuse-audit.md`; confirm MCP SDK v2 transport exports; create encrypted vault/SQLite migrations and fake IMAP/SMTP adapters. Then implement mailbox creation and owner authentication with tests before adding any agent-facing email tool.

## 16. Deferred extensions

Optional post-v1: provider-specific OAuth2 (Google/Microsoft), background IMAP IDLE, remote HTTPS/OAuth server, agent webhook/runner integration, advanced folder rules, configurable no-approval sending policies after separate security review, multiple human owners, incremental full-text indexing and cross-mailbox search. These are explicitly out of scope for the local-first approval-based v1.

---

**Definition of done:** A local desktop operator can add a secure IMAP/SMTP mailbox, assign scoped permissions to Codex or OMP, let agents inspect and compose messages over MCP, approve each outgoing email in a trusted local UI, and rely on polling-based receipt and persistence—without running a complete email server or exposing credentials to coding agents.
