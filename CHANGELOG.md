# Changelog

## 0.1.0 (unreleased)

- First release: an MCP proxy that puts supervisor approval in front of any
  database MCP server. Reads pass through; writes, schema changes and other
  changing tools wait for approval on a Hibira-hosted page (with push), then
  run once with exactly the approved arguments.
- SQL classifier (Postgres, MySQL, SQLite, SQL Server dialects) that skips
  comments, strings and dollar quotes and fails closed.
- `check_approval` tool for answers that take longer than the client waits.
- stdio and Streamable HTTP (with `GATE_TOKEN`) downstream; stdio command or
  Streamable HTTP URL upstream.
- Tested with DBHub, postgres-mcp and Supabase MCP.
