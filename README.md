# Approval gate for database MCP servers

`@hibira-io/mcp-approval-gate` sits in front of the MCP server that connects
your assistant to a database. Reads go straight through. Anything that changes
data or schema waits until **another person approves it** on a hosted approval
page, sent to their phone as a push notification. Then it runs once, exactly
as approved.

![An assistant asks to update an order; the change waits until a supervisor approves it on their phone, then runs once](https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/demo.gif)

<sub>A real session: Claude Code asks to mark order 1042 as refunded through DBHub. The `UPDATE` waits, the supervisor approves it on the Hibira page, and the assistant finishes the change. ([MP4](https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/demo.mp4))</sub>

It works with any MCP server, and is tested with:

- [DBHub](https://github.com/bytebase/dbhub) (Postgres, MySQL, MariaDB, SQL Server, SQLite)
- [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp) (`postgres-mcp`)
- [Supabase MCP](https://github.com/supabase-community/supabase-mcp) (local or `mcp.supabase.com`)

and with Claude (Desktop, Code and claude.ai), Cursor, ChatGPT and any other
MCP client.

```
assistant ──► approval gate ──► database MCP server ──► database
                  │  writes only
                  ▼
        Hibira approval page + push ──► supervisor taps Approve / Reject
```

## Why

Most database MCP servers offer two choices: read-only, or let the assistant
write anything. Client-side "allow this tool?" prompts are answered by the same
person who asked. The gate adds the step a team usually wants for production
data: a **supervisor approval** by someone else, with the exact statement in
front of them.

- **Bound to the exact call.** The approval covers one tool call with one set
  of arguments (shown with its fingerprint). If the statement changes, it needs
  a new approval. An approved call runs once.
- **Fails closed.** SQL the gate cannot read, and tools it does not know to be
  read-only, wait for approval. If the approval service cannot be reached,
  nothing runs.
- **Your database stays yours.** The gate runs where your database MCP server
  runs. Hibira only sees the approval request (title, statement, tool name),
  never your connection string or query results.
- **Clear for the reviewer.** The page shows the database label, the kind of
  change (`UPDATE`, `DROP TABLE`, ...), warnings such as "DELETE without WHERE
  changes every row", and the full statement.

<p>
  <img src="https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/approval-page.png" width="260" alt="The approval page on a phone: UPDATE on shop-production, with the statement, fingerprint and Approve / Reject buttons">
  <img src="https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/approval-approved.png" width="260" alt="The same request after the supervisor approved it">
</p>

## Setup

1. Sign in at [hibira.io](https://hibira.io), create an app (Free works), and
   copy its **App ID, Key and Secret**.
2. Optional: turn on Push for the app and subscribe the supervisors' devices to
   an interest such as `db-approvals`, so requests reach their phones. Without
   push, the assistant shows the approval link and you share it.
3. Put the gate in front of your database MCP server in your client's config
   (below). Everything after `--` is the database server's usual command.

The Hibira credentials are read from the environment only, and they are not
passed on to the database server.

### Claude Code

```sh
claude mcp add shop-db \
  -e HIBIRA_APP_ID=app_... -e HIBIRA_KEY=... -e HIBIRA_SECRET=... \
  -e GATE_LABEL=shop-production -e GATE_PUSH_INTERESTS=db-approvals \
  -- npx -y @hibira-io/mcp-approval-gate \
  -- npx -y @bytebase/dbhub --transport stdio --dsn "postgres://user:pass@host:5432/shop"
```

### Claude Desktop, Cursor, Windsurf, VS Code

`claude_desktop_config.json`, `.cursor/mcp.json` and the others take the same
shape:

```json
{
  "mcpServers": {
    "shop-db": {
      "command": "npx",
      "args": [
        "-y", "@hibira-io/mcp-approval-gate",
        "--label", "shop-production",
        "--push-interests", "db-approvals",
        "--",
        "npx", "-y", "@bytebase/dbhub", "--transport", "stdio",
        "--dsn", "postgres://user:pass@host:5432/shop"
      ],
      "env": {
        "HIBIRA_APP_ID": "app_...",
        "HIBIRA_KEY": "...",
        "HIBIRA_SECRET": "..."
      }
    }
  }
}
```

**postgres-mcp:**

```json
"args": ["-y", "@hibira-io/mcp-approval-gate", "--label", "analytics", "--",
         "uvx", "postgres-mcp", "--access-mode=unrestricted"],
"env": { "DATABASE_URI": "postgresql://...", "HIBIRA_APP_ID": "...", "HIBIRA_KEY": "...", "HIBIRA_SECRET": "..." }
```

`--access-mode=unrestricted` is fine here: the gate is what holds writes back.

**Supabase (local server):**

```json
"args": ["-y", "@hibira-io/mcp-approval-gate", "--label", "supabase-prod", "--",
         "npx", "-y", "@supabase/mcp-server-supabase@latest", "--project-ref=<project-ref>"],
"env": { "SUPABASE_ACCESS_TOKEN": "sbp_...", "HIBIRA_APP_ID": "...", "HIBIRA_KEY": "...", "HIBIRA_SECRET": "..." }
```

`execute_sql` with a `SELECT` runs right away; writes, `apply_migration`,
`deploy_edge_function`, branch merges and project pauses wait for approval.

**Supabase (hosted server):**

```json
"args": ["-y", "@hibira-io/mcp-approval-gate", "--label", "supabase-prod",
         "--upstream-url", "https://mcp.supabase.com/mcp?project_ref=<project-ref>",
         "--header", "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"],
```

### ChatGPT and claude.ai (remote)

Web clients need an HTTPS URL, so run the gate as a small server next to your
database and put HTTPS in front of it (your reverse proxy, a tunnel, or a
platform such as Fly.io or Railway):

```sh
export HIBIRA_APP_ID=app_... HIBIRA_KEY=... HIBIRA_SECRET=...
export GATE_TOKEN="$(openssl rand -hex 24)"   # keep it secret
npx -y @hibira-io/mcp-approval-gate --http --host 0.0.0.0 --port 8787 \
  --label shop-production --push-interests db-approvals \
  -- npx -y @bytebase/dbhub --transport stdio --dsn "$DATABASE_URL"
```

The endpoint is `https://your-host/mcp/<GATE_TOKEN>`; clients that can send
headers may use `https://your-host/mcp` with `Authorization: Bearer <GATE_TOKEN>`.

- **ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode, then
  Create: paste the URL with the token, authentication "No authentication".
- **claude.ai:** Settings → Connectors → Add custom connector, paste the URL
  with the token.

The gate refuses to listen on a non-local address without `GATE_TOKEN`.
A [Dockerfile](Dockerfile) is included.

## What the assistant sees

A write call waits up to 50 seconds (`--wait`) for the decision, sending
progress updates so the client does not give up early:

- **Approved:** the call runs and its normal result comes back, with a line
  saying it was approved.
- **Rejected or expired:** an error saying it did not run, with the
  supervisor's comment if they left one.
- **Still waiting:** a short answer with the approval link and `approval_id`.
  The gate adds one tool, `check_approval`: when the person says it is
  decided, the assistant calls it with that `approval_id`, and the call runs if
  it was approved. Asking for the same call again reuses the same request.

## What waits for approval

With the default `--mode writes`:

1. Tools listed in `--gate` always wait; tools in `--allow` never do (a
   trailing `*` matches a prefix).
2. Calls with SQL (an argument named `sql`, `query`, `statement`, `queries`,
   ...) wait if any statement changes something: `INSERT`, `UPDATE`,
   `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `COPY`,
   `CALL`, `DO`, `SET`, `VACUUM`, data-changing `WITH`, `SELECT ... INTO`,
   `EXPLAIN ANALYZE` of a write, `SELECT` of functions such as `setval` or
   `pg_terminate_backend`, and anything it cannot parse. Comments, strings and
   dollar-quoted bodies are skipped, so `SELECT 'DROP TABLE x'` is a read.
3. Other tools pass if they are marked `readOnlyHint` or named like a read
   (`list_`, `get_`, `search_`, `describe_`, `explain_`, `analyze_`, ...).
   Everything else waits.

`--mode all` sends every call for approval, reads included. `--mode none` turns
the gate off (useful while testing).

The gate is a second pair of eyes, not a permission system. Give the database
user only the rights it needs too.

## Options

| Flag | Env | Default | |
| --- | --- | --- | --- |
| | `HIBIRA_APP_ID`, `HIBIRA_KEY`, `HIBIRA_SECRET` | required | your Hibira app |
| | `HIBIRA_API_URL` | `https://ws.hibira.io` | |
| `--label` | `GATE_LABEL` | `database` | the database's name on the approval page |
| `--mode` | `GATE_MODE` | `writes` | `writes`, `all` or `none` |
| `--allow` | `GATE_ALLOW_TOOLS` | | tools that never wait |
| `--gate` | `GATE_TOOLS` | | tools that always wait |
| `--push-interests` | `GATE_PUSH_INTERESTS` | | push the request to these interests |
| `--push-users` | `GATE_PUSH_USERS` | | ...or to these user ids |
| `--channel` | `GATE_CHANNEL` | | also announce requests on this channel, e.g. for an [approvals inbox](https://github.com/hibira-io/approvals) |
| `--options` | `GATE_OPTIONS` | `Approve,Reject` | answer buttons; the first one approves |
| `--wait` | `GATE_WAIT_SECONDS` | `50` | how long a call waits before answering "still waiting" |
| `--expires` | `GATE_EXPIRES_MINUTES` | `60` | how long a request stays open (up to 7 days) |
| `-- <command>` | `GATE_COMMAND` | | the database MCP server to start |
| `--upstream-url` | `GATE_UPSTREAM_URL` | | ...or a remote one (Streamable HTTP) |
| `--header` | `GATE_UPSTREAM_HEADERS` | | headers for the remote server; `${VAR}` reads the environment |
| `--http` | | off | serve Streamable HTTP instead of stdio |
| `--host`, `--port` | `GATE_HOST`, `PORT` | `127.0.0.1`, `8787` | |
| | `GATE_TOKEN` | | required for `--http` on a non-local address |

Pending calls live in the gate's memory. If the gate restarts, a waiting call
is forgotten (nothing runs) and the assistant simply asks again.

## Development

```sh
npm install
npm test
# against real servers and a local Postgres:
DATABASE_URL=postgres://... node --test test/real-servers.e2e.js
```

## License

MIT

---

## 中文摘要

`@hibira-io/mcp-approval-gate` 套在任何数据库 MCP server（DBHub、postgres-mcp、Supabase MCP 等）外面：**读取直接通过；写入、改表、删除会先停下，等另一个人（主管）在 Hibira 托管的审批页或手机推播上核准**，核准后只按原样执行一次。

- 审批绑定这一次调用的完整参数（附指纹），SQL 改了就要重新审批。
- 看不懂的 SQL、不确定是否只读的工具一律要审批；审批服务连不上就不执行。
- Gate 跑在你自己的环境，Hibira 只经手审批内容，不碰数据库密码，也看不到查询结果。
- Claude（Desktop / Code / claude.ai）、Cursor、ChatGPT 都能用；网页端用 `--http` 加 `GATE_TOKEN`。
- 设定：在 hibira.io 建 app，把 App ID / Key / Secret 放进环境变量，在 `--` 后面接原本的数据库 MCP 指令。
