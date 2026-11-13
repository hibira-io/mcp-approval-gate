# Changelog

## 0.4.0

- `mcp-approval-gate hook claude|codex|cursor|hermes`: a hook for coding agents
  (Hermes Agent: the `terminal` tool through a `pre_tool_call` shell hook).
  Shell commands that delete files, rewrite git history, deploy, change
  infrastructure, publish packages or write to a database wait for a second
  person in the Hibira Approvals workspace; everything else runs as usual.
  Uses the same sign-in as the gate. `hook check -- <command>` shows whether
  a command would wait.
- Settings in `~/.config/hibira/approval-hook.json` (`always`, `never`,
  `approvers`, `wait`, `expires`), `GATE_HOOK_*` and `GATE_APPROVERS`; a
  project can add `always` rules and approvers in `.hibira/approval-hook.json`.

## 0.3.0

- No keys to copy: the gate connects to a Hibira Approvals workspace by
  sign-in. The first change that needs approval answers with a link and a
  code; a workspace admin connects it, and the gate keeps a workspace token
  (`~/.config/hibira/approval-gate.json`) that can only ask for and read that
  workspace's approvals. Requests go to the workspace's members, who decide
  signed in.
- `--approvers` / `GATE_APPROVERS`: limit who may decide to approver groups
  or members, and the answer names who approved ("Approved by Mei Lin").
- `mcp-approval-gate login | status | logout`, `--profile` / `GATE_PROFILE`,
  and `HIBIRA_APPROVALS_TOKEN` for servers and containers.
- `--preset stripe|github|gmail|shopify`: which tools of those servers only
  read, which wait, and plain approval titles. Patterns may now be `*suffix`.
- A Hibira app's `HIBIRA_APP_ID` / `HIBIRA_KEY` / `HIBIRA_SECRET` still work.

## 0.2.0

- The assistant no longer gets the approval link when the request reaches a
  supervisor by push (`--push-interests`, `--push-users`) or a channel
  (`--channel`), so the person in the chat cannot approve their own change.
  Without either, the link is still shown so you can forward it.
  `--show-link auto|always|never` (`GATE_SHOW_LINK`) controls this.
- New demo and screenshots: the request reaches the store manager's phone and
  the assistant continues once she approves.

## 0.1.0

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
