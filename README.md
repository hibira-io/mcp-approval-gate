# Approval gate for database MCP servers

`@hibira-io/mcp-approval-gate` sits in front of the MCP server that connects
your assistant to a database. Reads go straight through. Anything that changes
data or schema waits until **another person approves it** on a hosted approval
page, sent to their phone as a push notification. Then it runs once, exactly
as approved.

![An assistant asks to update an order; the change waits until a supervisor approves it on their phone, then runs once](https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/demo.gif)

<sub>A real session: Claude Code asks to mark order 1042 as refunded through DBHub. The `UPDATE` waits and the assistant never gets the approval link. The request shows up in the store manager's Hibira Approvals inbox on her phone (it is also sent to her as a push notification); she opens it, checks the statement and approves, and the assistant finishes the change. ([MP4](https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/demo.mp4) · [the same request rejected](https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/demo-reject.mp4))</sub>

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
  <img src="https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/supervisor-notification.png" width="240" alt="The supervisor's approvals inbox on her phone: UPDATE on shop-production is waiting for her">
  <img src="https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/approval-page.png" width="240" alt="The request in the approvals inbox: database, kind of change, the full statement and its fingerprint, with Approve and Reject">
  <img src="https://raw.githubusercontent.com/hibira-io/mcp-approval-gate/main/docs/approval-approved.png" width="240" alt="The same request after the supervisor approved it, with who answered and when">
</p>

## Setup

1. Create a **Hibira Approvals workspace** at [approvals.hibira.io](https://approvals.hibira.io)
   and invite the people who approve (store managers, DBAs, ...). They get
   requests on their phones and decide in the approvals inbox.
2. Put the gate in front of your database MCP server in your client's config
   (below). Everything after `--` is the database server's usual command.
   There are no keys to copy.
3. The first time the assistant tries to change something, it answers with a
   link and a short code. A workspace admin opens it, picks the workspace and
   presses **Connect**. From then on the gate is connected; reads work all
   along.

To connect ahead of time from a terminal instead, run
`npx -y @hibira-io/mcp-approval-gate login`. `status` and `logout` work the
same way. The connection is a token, kept in
`~/.config/hibira/approval-gate.json`, that can only ask for and read that
workspace's approvals. Admins see every connected gate in the workspace
settings and can revoke one at any time.

### Claude Code

```sh
claude mcp add shop-db -e GATE_LABEL=shop-production \
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
        "--",
        "npx", "-y", "@bytebase/dbhub", "--transport", "stdio",
        "--dsn", "postgres://user:pass@host:5432/shop"
      ]
    }
  }
}
```

**postgres-mcp:**

```json
"args": ["-y", "@hibira-io/mcp-approval-gate", "--label", "analytics", "--",
         "uvx", "postgres-mcp", "--access-mode=unrestricted"],
"env": { "DATABASE_URI": "postgresql://..." }
```

`--access-mode=unrestricted` is fine here: the gate is what holds writes back.

**Supabase (local server):**

```json
"args": ["-y", "@hibira-io/mcp-approval-gate", "--label", "supabase-prod", "--",
         "npx", "-y", "@supabase/mcp-server-supabase@latest", "--project-ref=<project-ref>"],
"env": { "SUPABASE_ACCESS_TOKEN": "sbp_..." }
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
npx -y @hibira-io/mcp-approval-gate login      # once, on the server
export GATE_TOKEN="$(openssl rand -hex 24)"   # keep it secret
npx -y @hibira-io/mcp-approval-gate --http --host 0.0.0.0 --port 8787 \
  --label shop-production \
  -- npx -y @bytebase/dbhub --transport stdio --dsn "$DATABASE_URL"
```

The endpoint is `https://your-host/mcp/<GATE_TOKEN>`; clients that can send
headers may use `https://your-host/mcp` with `Authorization: Bearer <GATE_TOKEN>`.

- **ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode, then
  Create: paste the URL with the token, authentication "No authentication".
- **claude.ai:** Settings → Connectors → Add custom connector, paste the URL
  with the token.

The gate refuses to listen on a non-local address without `GATE_TOKEN`.
A [Dockerfile](Dockerfile) is included. In a container, where there is no
terminal to sign in from, pass the workspace token as
`HIBIRA_APPROVALS_TOKEN` (copy it from `~/.config/hibira/approval-gate.json`
after `login` on any machine), or watch the gate's log for the connect link
on first start.

## Beyond databases: presets

The gate works in front of any MCP server. For a few common ones, `--preset`
knows which tools only read and which change something, and gives the
approval a plain title such as "Stripe: POST /v1/refunds" or "GitHub: merge
pull request acme/shop#42". `--allow` and `--gate` still win over a preset.

| Preset | Waits for approval | Runs right away |
| --- | --- | --- |
| `stripe` | `stripe_api_write`, `send_money`, `transfer_money`, `convert_currency`, ... | `stripe_api_read`, search, docs, analytics |
| `github` | merges, pushes, file changes, new repos, workflow runs, comments | `get_*`, `list_*`, `search_*`, `*_read` |
| `gmail` | sending, replying, forwarding, deleting, filters | reading, searching, drafts |
| `shopify` | `graphql_mutation`, creating, updating, discounts, inventory | queries, analytics, docs |

**Stripe** (hosted server, with an agent API key):

```sh
claude mcp add stripe -- npx -y @hibira-io/mcp-approval-gate --preset stripe \
  --upstream-url https://mcp.stripe.com --header 'Authorization: Bearer ${STRIPE_AGENT_KEY}'
```

**GitHub** (official server in Docker):

```sh
claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=... \
  -- npx -y @hibira-io/mcp-approval-gate --preset github \
  -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

For Gmail and Shopify, put `--preset gmail` or `--preset shopify` in front of
the server you already use. Tools a preset does not know follow the usual
rules below.

## What the assistant sees

A write call waits up to 50 seconds (`--wait`) for the decision, sending
progress updates so the client does not give up early:

- **Approved:** the call runs and its normal result comes back, with a line
  saying it was approved.
- **Rejected or expired:** an error saying it did not run, with the
  supervisor's comment if they left one.
- **Still waiting:** a short answer saying a supervisor has to approve it,
  with an `approval_id`. The gate adds one tool, `check_approval`: when the
  person says it is decided, the assistant calls it with that `approval_id`,
  and the call runs if it was approved. Asking for the same call again reuses
  the same request.

**The assistant does not get the approval link** when the gate is connected
to an Approvals workspace (its members are notified and decide signed in), or
when the request reaches the supervisor another way (`--push-interests`,
`--push-users` or `--channel`), so the person chatting with it cannot approve their own change
from the chat. Without any of those, the link is the only way to reach a
supervisor, so the assistant shows it for you to forward. `--show-link always`
or `never` overrides this.

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
| | `HIBIRA_APPROVALS_TOKEN` | | a workspace token, instead of signing in (servers, containers) |
| `--profile` | `GATE_PROFILE` | `default` | which saved connection to use, to connect gates on one machine to different workspaces |
| | `HIBIRA_APP_ID`, `HIBIRA_KEY`, `HIBIRA_SECRET` | | a Hibira app's keys instead, as in 0.2 (push and channel options apply to these) |
| | `HIBIRA_API_URL` | `https://ws.hibira.io` | |
| `--label` | `GATE_LABEL` | `database` | the database's name on the approval page |
| `--preset` | `GATE_PRESET` | | `stripe`, `github`, `gmail` or `shopify` (see above) |
| `--mode` | `GATE_MODE` | `writes` | `writes`, `all` or `none` |
| `--allow` | `GATE_ALLOW_TOOLS` | | tools that never wait |
| `--gate` | `GATE_TOOLS` | | tools that always wait |
| `--approvers` | `GATE_APPROVERS` | | who may decide, in an Approvals workspace: approver group slugs or members' emails (default: any admin or approver) |
| `--push-interests` | `GATE_PUSH_INTERESTS` | | push the request to these interests |
| `--push-users` | `GATE_PUSH_USERS` | | ...or to these user ids |
| `--channel` | `GATE_CHANNEL` | | also announce requests on this channel, e.g. for an [approvals inbox](https://github.com/hibira-io/approvals) |
| `--show-link` | `GATE_SHOW_LINK` | `auto` | give the assistant the approval link: `auto` (only without push or a channel), `always`, `never` |
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
- 设定了推播或频道时，助手拿不到审批链接，只有收到推播的主管能核准。
- 看不懂的 SQL、不确定是否只读的工具一律要审批；审批服务连不上就不执行。
- Gate 跑在你自己的环境，Hibira 只经手审批内容，不碰数据库密码，也看不到查询结果。
- Claude（Desktop / Code / claude.ai）、Cursor、ChatGPT 都能用；网页端用 `--http` 加 `GATE_TOKEN`。
- 设定：在 hibira.io 建立 Approvals 工作区并邀请审批人；设定里只要在 `--` 后面接原本的数据库 MCP 指令，不用复制任何 Key。第一次要写入时，助手会给一个连接链接和代码，由工作区管理员登入后按「连接」即可（也可先执行 `npx -y @hibira-io/mcp-approval-gate login`）。
