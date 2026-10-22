# Implementation status

This file tracks progress against `POSTMOTE_IMPLEMENTATION_PLAN.md`.

| Phase | Status | Evidence / blocker |
|---|---|---|
| P0 Research and bootstrap | In progress | Initial strict TypeScript/Bun project, config validation, local DB schema, and security notes added. SDK and mail library audit remains. |
| P1 State, secrets, and mail core | Partial | SQLite migration baseline, AES-GCM vault, scrypt owner password, mailbox input validation/storage. IMAP, SMTP, MIME, search, attachment handling, and polling absent. |
| P2 Approval system | Not started | No draft or approval workflow. |
| P3 MCP API | Not started | No MCP server or stdio bridge. |
| P4 UI and operations | Partial | `init`, `serve`, `doctor`, and `config show` bootstrap commands. Dashboard and other CLI operations absent. |
| P5 QA and release | Not started | No release matrix, integration suite, or benchmarks. |

## Next actionable task

Complete the first-run owner setup and authenticated mailbox UI/API; then verify Bun SQLite migration and vault behavior before integrating a real IMAP adapter.
