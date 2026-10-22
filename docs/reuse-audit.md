# Dependency and reuse audit

## Initial implementation

The bootstrap uses Bun's built-in SQLite and Node-compatible cryptography, `hono` for the local HTTP router, and `zod` for environment and mailbox input validation. No existing mail MCP server was copied or vendored.

## Deferred checks

The repository does not yet include the MCP SDK, ImapFlow, Nodemailer, MailParser, or Preact. Before adding those dependencies, verify the current upstream package exports, license, maintenance status, transitive dependency footprint, and compatibility with the pinned Bun runtime and compiled executable. Run the plan's real TLS mail integration suite against compiled binaries before treating a dependency as supported.

The two suggested mail MCP servers have not yet received the security and license review required by the implementation plan. No reuse decision is implied.
