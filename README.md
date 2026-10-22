# Postmote

**A lightweight, local-first mailbox bridge for coding agents.**

Postmote is an early implementation of a local IMAP/SMTP bridge. The current release is a bootstrap: it initializes a private data directory, creates an encrypted credential vault, stores mailbox configuration, and starts a loopback HTTP service. MCP transport, mail protocol operations, dashboard workflows, and approval-based delivery are not implemented yet.

## Requirements

- Bun 1.4 or newer

## Run from source

```sh
bun install
bun run src/main.ts --version
bun run src/main.ts init
bun run src/main.ts serve
```

The service binds only to `127.0.0.1:3145`. Runtime files are stored in the operating system's user data directory. Set `POSTMOTE_DATA_DIR` to override it.

The first owner setup endpoint is `POST /api/setup/initialize` with a JSON body containing a password of at least 12 characters. This bootstrap does not yet include a graphical setup form. Mailboxes can be stored with an authenticated owner session through the API; IMAP/SMTP connectivity is not implemented.

## Security status

- Mailbox passwords are encrypted with AES-256-GCM using a separate random key file.
- The owner password is stored as a scrypt hash.
- The database and key file use owner-only POSIX permissions.
- The HTTP listener is fixed to loopback, with Host and Origin checks.
- No MCP tools or SMTP send path are exposed in this version.

This is not ready for real mail accounts or production use. See [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for the work still required by the implementation specification.

## License

No license has been selected. All rights reserved by default; reuse is not granted.
