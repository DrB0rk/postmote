# Postmote

**A lightweight, local-first mailbox bridge for coding agents.**

Postmote is an early implementation of a local IMAP/SMTP bridge. The current release initializes a private data directory, creates an encrypted credential vault, provides a local owner dashboard for mailbox and agent configuration, and starts a loopback HTTP service. MCP provides IMAP access and approval-based email delivery. An agent with a dedicated inbox can also send directly to the owner-configured personal address.

## Requirements

- End users can install a compiled executable without Bun or Node.js.
- Bun 1.4 or newer is needed only to run from source.

## Install

On Linux or macOS, install the latest verified release with:

```sh
curl -fsSL https://raw.githubusercontent.com/DrB0rk/postmote/main/scripts/install.sh | sh
```

The installer detects Linux/macOS and x64/ARM64, verifies the downloaded binary against the release SHA-256 list, then installs it to `~/.local/bin`. To choose a different directory, set `POSTMOTE_INSTALL_DIR` before running the command. If that directory is not on your `PATH`, the installer prints the command to add it.

On Windows PowerShell, run:

```powershell
irm https://raw.githubusercontent.com/DrB0rk/postmote/main/scripts/install.ps1 | iex
```

Windows installs to `%USERPROFILE%\.local\bin`. Releases are built for Linux x64/ARM64, macOS x64/ARM64, and Windows x64. New downloadable releases are published when a `v*` version tag is pushed.

## Run from source

```sh
bun install
bun run src/main.ts --version
bun run src/main.ts init
bun run src/main.ts serve
```

The service binds only to `127.0.0.1:3145`. Runtime files are stored in the operating system's user data directory. Set `POSTMOTE_DATA_DIR` to an absolute path or `~/...` path to override it.

The vault key defaults to `master.key` in the data directory. To keep it elsewhere, set `POSTMOTE_MASTER_KEY_FILE` to an absolute path (or `~/...`) whose parent directory already exists, and use the same setting for the daemon, stdio clients and backup command. For an existing installation, stop Postmote, securely copy the existing key to that path, set the variable, and verify access before removing the old copy. Postmote refuses to create a replacement key when encrypted mailbox data already exists.

On the first visit, the dashboard prompts you to create an owner password. Add or edit mailboxes and provision agent tokens from the dashboard. Removing a mailbox removes its local index, drafts and send history; it does not delete messages on the mail server. Mailbox credentials are encrypted before they are stored. Use **Find Thunderbird profiles** to import a local Thunderbird IMAP account and its saved passwords, or fill in the settings and enter passwords manually. Enter the Thunderbird primary password if one is set. Saved-password import requires Thunderbird’s NSS library and has been verified on Linux; if unavailable on another platform, use manual password entry. OAuth and POP accounts are not supported.

After configuring a mailbox, an authenticated owner can create an agent with `POST /api/agents` and grant its access with `PUT /api/agents/:id/grants`. The generated bearer token is returned once. Point an MCP client at `http://127.0.0.1:3145/mcp` with that token. Available tools are `mail_accounts`, `mail_status`, `mail_poll`, `mail_folders`, `mail_list`, `mail_search`, `mail_read`, `mail_get`, `mail_attachment_info`, `mail_attachment_read`, `mail_draft_create`, `mail_draft_get`, `mail_draft_update`, `mail_draft_delete`, `mail_reply_draft`, `mail_forward_draft`, `mail_flags`, `mail_move`, `mail_delete`, `mail_send_request`, and `mail_send_status`. Grant `mail.read` to list and read messages, `mail.search` to search, `mail.attachments` to retrieve attachment chunks, `mail.draft` to edit drafts, `mail.reply` or `mail.forward` with `mail.draft` to prepare replies or forwards, `mail.modify` to change flags or move messages, `mail.delete` to move messages to Trash, and `mail.send.request` to request delivery or inspect request status. Search supports text, from, to, subject and unread filters with paged results. Search cursors expire after an hour and become invalid when the server restarts. The owner can edit existing agent permissions in the dashboard. Each send request requires an idempotency key that can safely be reused when retrying the same message. Open Pending email requests in the dashboard to review and approve or reject each request. Requests expire after 24 hours. SMTP submissions default to a limit of 30 per hour; set `POSTMOTE_MAX_SENDS_PER_HOUR` to change it. `mail_list` returns the folder UIDVALIDITY and message references; pass their UIDVALIDITY and UID to `mail_read`, which returns untrusted raw message source up to 1 MiB. `mail_get` returns parsed plain text and attachment metadata, and attachment reads return at most 256 KiB per call. Raw message reads are limited to 1 MiB. Parsed message and attachment operations currently buffer the original message, which must fit within 25 MiB; individual attachments are limited to 10 MiB. A stale UIDVALIDITY is rejected. The daemon polls INBOX metadata at the configured interval; `mail_poll` triggers one batch. The unread count is unavailable while a multi-batch scan is incomplete. Forwarding messages with attachments is not yet supported. If delivery cannot be confirmed, check the sent folder before creating another request.

MCP also exposes scoped account, mailbox-status and message-text resources, plus inbox-summary, reply-preparation and triage prompts. These are conveniences for an already connected agent; they do not authorize sending or execute instructions found in email.

## Give an agent its own inbox

Create an email account with an IMAP/SMTP provider first. Postmote does not create provider accounts. Set your personal address under **Personal email**, then add the agent mailbox through the dashboard and assign it under the agent’s **Edit permissions** controls. An assigned agent has full access to that mailbox, including permanent deletion when the mail server supports targeted deletion. Its access to other mailboxes still requires separate grants.

Alternatively, enable **Allow this agent to configure its own existing IMAP/SMTP account** when creating or editing the agent. The agent can then use `agent_inbox_setup` once with the account credentials; those credentials are visible to the agent and its client. `agent_inbox` returns the assigned mailbox and your configured address. `mail_send_owner` sends directly from that inbox to your address, with an idempotency key and the same hourly limit as approved sends. It accepts no recipient argument. Mail to other addresses uses `mail_send_request` and requires your approval. `agent_inbox_update` lets the agent update only its own inbox settings.

## Connect an MCP client over stdio

Create an agent in the dashboard and grant the mailbox permissions it needs. Copy its token when it is created. Configure your MCP client to start the installed executable, for example:

```json
{
  "mcpServers": {
    "postmote": {
      "command": "/home/YOUR_USER/.local/bin/postmote",
      "args": ["mcp", "stdio"],
      "env": {
        "POSTMOTE_AGENT_TOKEN": "YOUR_AGENT_TOKEN"
      }
    }
  }
}
```

Replace the path and token with your own. If you use a custom data directory, also set `POSTMOTE_DATA_DIR` in `env`. Treat the client configuration as a secret. The stdio process accesses local data directly and does not need the HTTP daemon for mailbox tools. Run `postmote serve` to manage accounts and approve outgoing requests. Token rotation, revocation, and mailbox grants also apply to running stdio sessions.

## Back up local data

Run `postmote backup /absolute/path/to/new-backup` to create a consistent database snapshot and copy its vault key into a new directory. The destination must not already exist. The backup includes the key and can decrypt stored credentials, so keep it private. To restore, stop Postmote and copy both `postmote.db` and `master.key` from the backup into a fresh Postmote data directory before starting it. If `POSTMOTE_MASTER_KEY_FILE` is set, restore the key to that configured path instead; keep the original data until the restore has been verified.

## Security status

- Mailbox passwords are encrypted with AES-256-GCM using a separate random key file.
- The owner password is stored as a scrypt hash, and the dashboard session uses an HttpOnly, SameSite=Strict cookie.
- The database and key file use owner-only POSIX permissions.
- The HTTP listener is fixed to loopback, with Host and Origin checks.
- IMAP and SMTP checks require verified TLS or mandatory STARTTLS; raw library errors are not returned to the dashboard.
- MCP tokens are high-entropy bearer credentials; only their SHA-256 hashes are stored.
- MCP account listing filters mailboxes by explicit grants, and mailbox status requires `mail.read`.
- Message access requires an explicit grant or a dedicated-inbox assignment. A dedicated agent can send directly only to the configured personal address; other outgoing mail requires owner approval.

This remains an early implementation; test with a dedicated account before relying on it. See [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for the work still required by the implementation specification.

## License

No license has been selected. All rights reserved by default; reuse is not granted.
