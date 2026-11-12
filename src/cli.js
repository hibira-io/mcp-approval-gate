// mcp-approval-gate [options] -- <database MCP server command...>
// mcp-approval-gate [options] --upstream-url https://.../mcp

import { createServer as createHttpServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalsClient } from './hibira.js';
import { ConnectingApprovals, DeviceLogin, TokenStore, WorkspaceClient, configPath, DEFAULT_URL } from './connect.js';
import { Gate, VERSION } from './gate.js';

const HELP = `Usage:
  mcp-approval-gate [options] -- <command> [args...]   wrap a local (stdio) database MCP server
  mcp-approval-gate [options] --upstream-url <url>     wrap a remote (Streamable HTTP) MCP server
  GATE_COMMAND="<command> [args...]" mcp-approval-gate  the same as after --, from the environment

Reads pass through. Calls that change data or schema wait for a supervisor's
approval on a Hibira-hosted page (with push), then run once.

Connecting to Hibira Approvals (no keys to copy):
  The first change that needs approval answers with a sign-in link and code.
  Open it, pick the Approvals workspace whose members approve, and the gate
  keeps a workspace token in ~/.config/hibira/approval-gate.json.
  mcp-approval-gate login [--profile <name>]    connect now, from a terminal
  mcp-approval-gate status | logout [--profile <name>]
  HIBIRA_APPROVALS_TOKEN    a workspace token from the environment instead (servers, containers)
  HIBIRA_APP_ID, HIBIRA_KEY, HIBIRA_SECRET   or a Hibira app's keys (as in 0.2)
  HIBIRA_APPROVALS_URL      default https://approvals.hibira.io

Options (each also as an env var, shown in brackets):
  --label <name>            name of the database on the approval page [GATE_LABEL]
  --mode <writes|all|none>  what waits: writes (default), every call, or nothing [GATE_MODE]
  --allow <tools>           comma-separated tools that never wait (* suffix ok) [GATE_ALLOW_TOOLS]
  --gate <tools>            comma-separated tools that always wait [GATE_TOOLS]
  --approvers <list>        who may decide, in an Approvals workspace: group slugs or members' emails [GATE_APPROVERS]
  --push-interests <list>   send the approval link as a push to these interests [GATE_PUSH_INTERESTS]
  --push-users <list>       ...or to these user ids [GATE_PUSH_USERS]
  --channel <name>          also announce requests on this channel (approvals inbox) [GATE_CHANNEL]
  --options <a,b>           answer buttons, first one approves (default Approve,Reject) [GATE_OPTIONS]
  --show-link <auto|always|never>  give the assistant the approval link; auto (default) only when
                            no push or channel delivers it to the supervisor [GATE_SHOW_LINK]
  --wait <seconds>          how long a call waits before answering "pending" (default 50) [GATE_WAIT_SECONDS]
  --expires <minutes>       how long a request stays open (default 60) [GATE_EXPIRES_MINUTES]
  --upstream-url <url>      remote MCP server to wrap [GATE_UPSTREAM_URL]
  --header "Name: value"    header for the remote server, repeatable; \${VAR} reads the environment [GATE_UPSTREAM_HEADERS, one per line]
  --http                    serve Streamable HTTP instead of stdio (for ChatGPT and remote clients)
  --port <n>                HTTP port (default 8787) [PORT]
  --host <addr>             HTTP bind address (default 127.0.0.1) [GATE_HOST]
  GATE_TOKEN                HTTP access token: Authorization: Bearer <token>, or the URL /mcp/<token>
  --profile <name>          which saved connection to use (default "default") [GATE_PROFILE]
  --version, --help
`;

function list(v) {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Splits a command line on spaces, honouring '...' and "..." quotes (no shell). */
export function splitCommand(line) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('GATE_COMMAND has an unclosed quote');
  if (has || cur) out.push(cur);
  return out;
}

function fail(msg) {
  process.stderr.write(`mcp-approval-gate: ${msg}\n`);
  process.exit(2);
}

export function parse(argv, env) {
  const sub = ['login', 'logout', 'status'].includes(argv[0]) ? argv[0] : undefined;
  if (sub) argv = argv.slice(1);
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? splitCommand(env.GATE_COMMAND ?? '') : argv.slice(dash + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      label: { type: 'string' }, mode: { type: 'string' }, allow: { type: 'string' }, gate: { type: 'string' },
      approvers: { type: 'string' }, 'push-interests': { type: 'string' }, 'push-users': { type: 'string' }, channel: { type: 'string' },
      options: { type: 'string' }, wait: { type: 'string' }, expires: { type: 'string' }, 'show-link': { type: 'string' },
      'upstream-url': { type: 'string' }, header: { type: 'string', multiple: true },
      profile: { type: 'string' },
      http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' },
      version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const mode = values.mode ?? env.GATE_MODE ?? 'writes';
  if (!['writes', 'all', 'none'].includes(mode)) throw new Error('--mode must be writes, all or none');
  const headerLines = values.header ?? (env.GATE_UPSTREAM_HEADERS ? env.GATE_UPSTREAM_HEADERS.split('\n') : []);
  const headers = {};
  for (const h of headerLines) {
    const i = h.indexOf(':');
    if (i < 1) throw new Error(`bad header "${h}", expected "Name: value"`);
    // ${NAME} reads an environment variable, so tokens stay out of configs.
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => env[k] ?? '');
  }
  const num = (v, d, name, lo, hi) => {
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  const opts = {
    help: values.help, version: values.version, sub,
    command,
    upstreamUrl: values['upstream-url'] ?? env.GATE_UPSTREAM_URL,
    headers,
    label: values.label ?? env.GATE_LABEL,
    mode,
    allowTools: list(values.allow ?? env.GATE_ALLOW_TOOLS),
    gateTools: list(values.gate ?? env.GATE_TOOLS),
    approvers: list(values.approvers ?? env.GATE_APPROVERS),
    pushInterests: list(values['push-interests'] ?? env.GATE_PUSH_INTERESTS),
    pushUsers: list(values['push-users'] ?? env.GATE_PUSH_USERS),
    channel: values.channel ?? env.GATE_CHANNEL,
    options: list(values.options ?? env.GATE_OPTIONS),
    waitSeconds: num(values.wait ?? env.GATE_WAIT_SECONDS, 50, '--wait', 0, 3600),
    expiresMinutes: num(values.expires ?? env.GATE_EXPIRES_MINUTES, 60, '--expires', 1, 10080),
    showLink: values['show-link'] ?? env.GATE_SHOW_LINK ?? 'auto',
    http: values.http ?? false,
    port: num(values.port ?? env.PORT, 8787, '--port', 1, 65535),
    host: values.host ?? env.GATE_HOST ?? '127.0.0.1',
    token: env.GATE_TOKEN,
    profile: values.profile ?? env.GATE_PROFILE ?? 'default',
  };
  if (!['auto', 'always', 'never'].includes(opts.showLink)) throw new Error('--show-link must be auto, always or never');
  if (opts.pushInterests.length && opts.pushUsers.length) throw new Error('give --push-interests or --push-users, not both');
  if (!opts.help && !opts.version && !opts.sub && !opts.command.length && !opts.upstreamUrl) {
    throw new Error('give the database MCP server to wrap after -- (or in GATE_COMMAND), or --upstream-url');
  }
  if (opts.command.length && opts.upstreamUrl) throw new Error('give a command after -- or --upstream-url, not both');
  return opts;
}

/** The environment for the wrapped server: everything but the Hibira credentials. */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.startsWith('HIBIRA_') && k !== 'GATE_TOKEN'));
}

async function connectUpstream(opts) {
  const client = new Client({ name: 'hibira-mcp-approval-gate', version: VERSION }, { capabilities: {} });
  const transport = opts.upstreamUrl
    ? new StreamableHTTPClientTransport(new URL(opts.upstreamUrl), { requestInit: { headers: opts.headers } })
    : new StdioClientTransport({ command: opts.command[0], args: opts.command.slice(1), env: childEnv(process.env), stderr: 'inherit' });
  await client.connect(transport);
  return client;
}

function tokenOk(given, want) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveHttp(gate, opts, log) {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(opts.host);
  if (!opts.token && !loopback) fail('set GATE_TOKEN before serving HTTP on a non-local address');
  const sessions = new Map();
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    const m = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    if (opts.token) {
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!tokenOk(m[1] ?? bearer, opts.token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end('bad JSON');
        return;
      }
    }
    const sid = req.headers['mcp-session-id'];
    let transport = sid && sessions.get(sid);
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(sid ? 404 : 400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'unknown session' : 'initialize first' }, id: null }));
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await gate.createServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  http.listen(opts.port, opts.host, () => log(`serving MCP on http://${opts.host}:${opts.port}/mcp`));
  return http;
}

export async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2), process.env);
  } catch (err) {
    fail(`${err.message}\n\n${HELP}`);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const log = (msg) => process.stderr.write(`[approval-gate] ${msg}\n`);
  const env = process.env;
  const baseUrl = env.HIBIRA_APPROVALS_URL || DEFAULT_URL;
  const store = new TokenStore(configPath(env));
  if (opts.sub) return account(opts, store, baseUrl);
  let approvals;
  try {
    if (env.HIBIRA_APP_ID || env.HIBIRA_KEY || env.HIBIRA_SECRET) {
      approvals = new ApprovalsClient({
        appId: env.HIBIRA_APP_ID, key: env.HIBIRA_KEY, secret: env.HIBIRA_SECRET,
        baseUrl: env.HIBIRA_API_URL || undefined,
      });
    } else if (env.HIBIRA_APPROVALS_TOKEN) {
      approvals = new WorkspaceClient({ token: env.HIBIRA_APPROVALS_TOKEN, baseUrl });
    } else {
      approvals = new ConnectingApprovals({ store, profile: opts.profile, baseUrl, label: opts.label, log });
      if (approvals.connected) log(`connected to Hibira Approvals workspace ${approvals.workspace?.name ?? ''}`.trimEnd());
      else if (opts.http) approvals.connect().catch((err) => log(`could not start connecting: ${err.message}`));
    }
  } catch (err) {
    fail(err.message);
  }
  let upstream;
  try {
    upstream = await connectUpstream(opts);
  } catch (err) {
    fail(`could not start the database MCP server: ${err.message}`);
  }
  const gate = new Gate({ ...opts, upstream, approvals, log });
  if (opts.http) {
    serveHttp(gate, opts, log);
  } else {
    const server = gate.createServer();
    await server.connect(new StdioServerTransport());
    process.stdin.on('end', () => stop());
  }
  async function stop() {
    await upstream.close().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  upstream.onclose = () => {
    log('the database MCP server exited');
    process.exit(1);
  };
}


async function account(opts, store, baseUrl) {
  const out = (m) => process.stdout.write(`${m}\n`);
  const saved = store.get(opts.profile);
  if (opts.sub === 'status') {
    out(saved ? `Connected to Hibira Approvals workspace ${saved.workspace?.name ?? saved.workspace?.id ?? ''} (profile ${opts.profile}).` : `Not connected (profile ${opts.profile}).`);
    return;
  }
  if (opts.sub === 'logout') {
    store.set(opts.profile, undefined);
    out(saved ? 'Disconnected on this machine. Revoke the gate in the workspace settings too if the token may have been copied.' : 'Nothing to disconnect.');
    return;
  }
  const flow = new DeviceLogin({ baseUrl, label: opts.label });
  const start = await flow.start();
  out(`Open ${start.verification_uri_complete || start.verification_uri} and confirm the code ${start.user_code}.`);
  out('Waiting for you to pick a workspace...');
  const res = await flow.wait(start);
  store.set(opts.profile, { token: res.access_token, workspace: res.workspace, url: baseUrl, connected_at: new Date().toISOString() });
  out(`Connected to ${res.workspace?.name ?? 'the workspace'}. Approval requests from this machine now go to its members.`);
}
