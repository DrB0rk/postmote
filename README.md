# Postmote

**A lightweight, local-first mailbox bridge for coding agents.**

Postmote is an early implementation of a local IMAP/SMTP bridge. The current release initializes a private data directory, creates an encrypted credential vault, provides a local owner dashboard for mailbox and agent configuration, and starts a loopback HTTP service. MCP currently exposes mailbox metadata and status only; mail protocol operations, polling, and approval-based delivery are not implemented yet.

## Requirements

- Bun 1.4 or newer

## Run from source

```sh
bun install
bun run src/main.ts --version
bun run src/main.ts init
bun run src/main.ts serve
```

The service binds only to `127.0.0.1:3145`. Runtime files are stored in the operating system's user data directory. Set `POSTMOTE_DATA_DIR` to an absolute path or `~/...` path to override it.

On the first visit, the dashboard prompts you to create an owner password. Add a mailbox and provision agent tokens from the dashboard. Mailbox credentials are encrypted before they are stored. IMAP/SMTP connection checks are available; mail sync and message operations are not implemented yet.

After configuring a mailbox, an authenticated owner can create an agent with `POST /api/agents` and grant its access with `PUT /api/agents/:id/grants`. The generated bearer token is returned once. Point an MCP client at `http://127.0.0.1:3145/mcp` with that token. Available tools are `mail_accounts` and `mail_status`; there are no message read or send tools yet.

## Security status

- Mailbox passwords are encrypted with AES-256-GCM using a separate random key file.
- The owner password is stored as a scrypt hash, and the dashboard session uses an HttpOnly, SameSite=Strict cookie.
- The database and key file use owner-only POSIX permissions.
- The HTTP listener is fixed to loopback, with Host and Origin checks.
- IMAP and SMTP checks require verified TLS or mandatory STARTTLS; raw library errors are not returned to the dashboard.
- MCP tokens are high-entropy bearer credentials; only their SHA-256 hashes are stored.
- MCP account listing filters mailboxes by explicit grants, and mailbox status requires `mail.read`.
- No message read or SMTP send path is exposed in this version.

This is not ready for real mail accounts or production use. See [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for the work still required by the implementation specification.

## License

No license has been selected. All rights reserved by default; reuse is not granted.
