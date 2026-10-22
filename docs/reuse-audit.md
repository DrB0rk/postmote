# Dependency and reuse audit

## Initial implementation

The bootstrap uses Bun's built-in SQLite and Node-compatible cryptography, `hono` for the local HTTP router, `zod` for environment and mailbox input validation, the official `@modelcontextprotocol/server` v2 package for MCP HTTP handling, ImapFlow for IMAP connection verification, and Nodemailer for SMTP connection verification. Installed versions are `@modelcontextprotocol/server` 2.3.1 (Apache-2.0), `imapflow` 2.9.0 (MIT), and `nodemailer` 10.2.1 (MIT-0). The MCP package export map confirms its root ESM entry and `createMcpHandler`, `McpServer` exports. Bun compile bundling succeeds locally. No existing mail MCP server was copied or vendored.

ImapFlow documents ESM support and Bun tests; SMTP via Nodemailer is documented to work under Bun. IMAP uses `secure: true` for TLS and `doSTARTTLS: true` for mandatory STARTTLS. SMTP uses `secure: true` or `requireTLS: true`; no TLS verification bypass is configured. See [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/), [ImapFlow searching](https://imapflow.com/docs/guides/searching/), and [Nodemailer SMTP](https://nodemailer.com/smtp). These libraries currently power connection verification only; compiled-binary protocol integration tests remain required.

## Deferred checks

MailParser and Preact are not included yet. MailParser is MIT-licensed and has a streaming parser API, but its current upstream package does not claim Bun support. If added, use `MailParser` streams rather than `simpleParser` for untrusted or large messages, enforce source and attachment byte limits, and release every attachment stream. The parser still needs a Bun-specific smoke test. Before declaring any dependency supported, run the plan's real TLS mail integration suite against compiled binaries.

The two suggested mail MCP servers have not yet received the security and license review required by the implementation plan. No reuse decision is implied.
