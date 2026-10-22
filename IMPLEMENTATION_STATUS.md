# Implementation status

This file tracks progress against `POSTMOTE_IMPLEMENTATION_PLAN.md`.

| Phase | Status | Evidence / blocker |
|---|---|---|
| P0 Research and bootstrap | Partial | Strict TypeScript/Bun project, config validation, local DB schema, security notes, SDK v2 export check, and local compile check. Mail library compatibility/reuse audit remains. |
| P1 State, secrets, and mail core | Partial | SQLite migrations through v2, AES-GCM vault, scrypt owner password, mailbox validation/storage, and verified-TLS IMAP/SMTP connection tests. Folder/message operations, MIME, search, attachments, and polling absent. |
| P2 Approval system | Not started | No draft or approval workflow. |
| P3 MCP API | Partial | Official SDK v2 HTTP handler, scoped agent bearer auth and revocation, `mail_accounts`, and `mail_status`. No mail operations, resources, prompts, or stdio bridge. |
| P4 UI and operations | Partial | `init`, `serve`, `doctor`, `config show`, self-contained owner setup/login/mailbox/agent/grant dashboard, mailbox connection tests, token rotation, and revoke. Polling, grant editing UI, approvals UI, and other CLI operations absent. |
| P5 QA and release | Partial | End-to-end owner/MCP and installer tests, compiled executable smoke check, checksum-verified installers, and a tag-triggered release matrix for Linux/macOS/Windows. No versioned binary release has been published yet. |

## Next actionable task

Publish the first versioned release to activate the download installers, then implement IMAP folder listing and bounded message metadata/body reads using the verified ImapFlow API; add MIME parsing and permission-isolation tests before exposing message-reading MCP tools.
