# Postmote 0.2.0

This early release adds Thunderbird profile and saved-password import, IMAP mailbox access over HTTP and stdio MCP, editable drafts and owner-approved sending, dedicated agent inboxes, polling, backup, and updated installers. A dedicated agent may send directly to the owner's configured personal address; other recipients require owner approval.

Create an account with an email provider before adding a dedicated agent inbox. OAuth and POP are not supported. Thunderbird saved-password import has been tested on Linux; other platforms can enter passwords manually.

This release does not meet all production-readiness gates. The default vault key is stored alongside the database unless `POSTMOTE_MASTER_KEY_FILE` is configured; there has been no independent security review. Some planned mail features and cross-platform protocol tests remain incomplete. See [implementation status](https://github.com/DrB0rk/postmote/blob/v0.2.0/IMPLEMENTATION_STATUS.md) for details.
