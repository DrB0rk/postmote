# Security notes

Postmote binds its HTTP server to loopback and rejects unexpected Host and Origin headers. The mailbox API requires a cookie session, and setup can be initialized only once. The owner password is scrypt-hashed. Mailbox credentials use AES-256-GCM with a fresh nonce and mailbox ID as associated data. The database and key file live in the user data directory and are chmod 0600 on POSIX systems.

The bootstrap has not received a security audit. Agent tokens are high-entropy values stored as SHA-256 hashes and each MCP mailbox operation checks its grant. Login, setup, MCP, and connection tests have in-process rate limits. IMAP/SMTP checks require verified TLS or mandatory STARTTLS and return categorized, redacted errors. It currently lacks mailbox reads, mail parsing, attachments, and outbound delivery. Do not use it with real mail credentials until these gaps are addressed.
