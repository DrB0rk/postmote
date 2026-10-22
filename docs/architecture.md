# Architecture status

The current bootstrap is a single-process Bun application. `src/main.ts` owns CLI dispatch and the loopback HTTP server. `src/config.ts` validates runtime settings, `src/db.ts` creates the SQLite schema, and `src/vault.ts` encrypts mailbox secrets using a standalone master key. Mailbox payload validation lives in `src/mailbox.ts`.

The intended daemon, MCP transport, IMAP/SMTP adapters, outbox approval flow, poller, and embedded dashboard are not implemented. See `IMPLEMENTATION_STATUS.md` for phase-by-phase status.
