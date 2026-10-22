# Architecture status

Postmote is a single-process Bun application. `src/main.ts` owns CLI dispatch, the loopback HTTP server, owner dashboard, account and agent administration, and the MCP HTTP endpoint. `src/config.ts` validates runtime settings, `src/db.ts` creates and migrates the SQLite schema, and `src/vault.ts` encrypts mailbox credentials using a standalone master key. `src/mail/connections.ts` tests IMAP and SMTP TLS connections. `src/mailbox.ts` validates mailbox settings.

The current MCP tools expose only account metadata and status. IMAP folder/message operations, MIME and attachment handling, polling, draft review and approved sending, stdio forwarding, and multi-platform release artifacts remain unimplemented. See `IMPLEMENTATION_STATUS.md` for phase-by-phase status.
