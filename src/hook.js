// mcp-approval-gate hook: a command hook for coding agents (Claude Code
// PreToolUse, Codex PreToolUse, Cursor beforeShellExecution). Risky shell
// commands wait until a second person approves them in a Hibira Approvals
// workspace; everything else runs as usual.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyShell } from './shell.js';
import { ApprovalsClient } from './hibira.js';
import { TokenStore, WorkspaceClient, configPath, DEFAULT_URL } from './connect.js';

export const AGENTS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const LOGIN = 'npx -y @hibira-io/mcp-approval-gate login --label "coding agent"';
const REJECT_MEMORY_MS = 15 * 60 * 1000;

const HELP = `Usage:
  mcp-approval-gate hook [claude|codex|cursor]   run as the agent's hook (reads the hook JSON on stdin)
  mcp-approval-gate hook check -- <command...>   show whether a command would wait for approval

Shell commands that delete files, force-push, deploy, change infrastructure,
publish packages or write to a database wait for a second person to approve
them in your Hibira Approvals workspace. Connect once with:
  ${LOGIN}

Settings (env, or ~/.config/hibira/approval-hook.json with the keys in brackets):
  GATE_HOOK=off                  turn the hook off [enabled: false]
  GATE_HOOK_ALWAYS               regexes, one per line: also ask for these [always]
  GATE_HOOK_NEVER                regexes, one per line: never ask for these [never]
  GATE_APPROVERS                 comma-separated approver emails or groups [approvers]
  GATE_HOOK_WAIT                 seconds to wait for an answer, default 600 [wait]
  GATE_EXPIRES_MINUTES           how long a request stays open, default 30 [expires]
  GATE_PROFILE                   which connected workspace to use, default "default" [profile]
A project can add rules (never remove them) in .hibira/approval-hook.json: { "always": [...], "approvers": [...] }.
`;

/** Reads settings from the user's config file, the project's file and the environment. */
export function loadSettings(env = process.env, cwd = process.cwd()) {
  const readJson = (p) => {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const user = readJson(join(dirname(configPath(env)), 'approval-hook.json'));
  const project = readJson(join(cwd, '.hibira', 'approval-hook.json'));
  const lines = (v) => (v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;
  };
  return {
    enabled: env.GATE_HOOK ? !/^(off|0|false|no)$/i.test(env.GATE_HOOK) : user.enabled !== false,
    always: [...arr(user.always), ...arr(project.always), ...lines(env.GATE_HOOK_ALWAYS)],
    never: [...arr(user.never), ...lines(env.GATE_HOOK_NEVER)],
    approvers: env.GATE_APPROVERS ? env.GATE_APPROVERS.split(',').map((s) => s.trim()).filter(Boolean)
      : arr(project.approvers).length ? arr(project.approvers) : arr(user.approvers),
    waitSeconds: num(env.GATE_HOOK_WAIT ?? user.wait, 600, 0, 3600),
    expiresMinutes: num(env.GATE_EXPIRES_MINUTES ?? user.expires, 30, 1, 10080),
    profile: env.GATE_PROFILE || user.profile || 'default',
    pushInterests: (env.GATE_PUSH_INTERESTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    pushUsers: (env.GATE_PUSH_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    channel: env.GATE_CHANNEL || undefined,
  };
}

/** Picks how to ask: app keys, a token from the environment, or the connected workspace. */
export function approvalsFromEnv(env, settings) {
  if (env.HIBIRA_APP_ID || env.HIBIRA_KEY || env.HIBIRA_SECRET) {
    return new ApprovalsClient({ appId: env.HIBIRA_APP_ID, key: env.HIBIRA_KEY, secret: env.HIBIRA_SECRET, baseUrl: env.HIBIRA_API_URL || undefined });
  }
  const baseUrl = env.HIBIRA_APPROVALS_URL || DEFAULT_URL;
  if (env.HIBIRA_APPROVALS_TOKEN) return new WorkspaceClient({ token: env.HIBIRA_APPROVALS_TOKEN, baseUrl });
  const saved = new TokenStore(configPath(env)).get(settings.profile);
  if (saved?.token) return new WorkspaceClient({ token: saved.token, baseUrl: saved.url || baseUrl });
  return undefined;
}

/** Which agent sent this input, and the shell command in it (undefined for other tools). */
export function readInput(input, client) {
  if (!input || typeof input !== 'object') return {};
  let agent = client;
  if (!agent) {
    if (input.hook_event_name === 'beforeShellExecution' || (typeof input.command === 'string' && !input.tool_name)) agent = 'cursor';
    else if ('turn_id' in input) agent = 'codex';
    else agent = 'claude';
  }
  if (agent === 'cursor') {
    return { agent, command: typeof input.command === 'string' ? input.command : undefined, cwd: input.cwd || process.cwd() };
  }
  const shellTool = /^(Bash|Shell|shell|exec_command|local_shell|run_terminal_cmd)$/.test(input.tool_name ?? '');
  let command = input.tool_input?.command;
  if (Array.isArray(command)) command = command.join(' ');
  return {
    agent,
    command: shellTool && typeof command === 'string' ? command : undefined,
    cwd: input.cwd || process.cwd(),
    session: input.session_id,
  };
}

/** What the agent is told. kind: pass | approved | deny. */
export function render(agent, { kind, reason, userMessage }) {
  if (agent === 'cursor') {
    if (kind === 'deny') return { permission: 'deny', user_message: userMessage ?? reason, agent_message: reason };
    return kind === 'approved' ? { permission: 'allow', user_message: userMessage } : { permission: 'allow' };
  }
  if (kind === 'pass') return undefined;
  if (kind === 'approved') return userMessage ? { systemMessage: userMessage } : undefined;
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  if (userMessage && agent === 'claude') out.systemMessage = userMessage;
  return out;
}

class State {
  constructor(path) {
    this.path = path;
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) ?? {};
    } catch {
      return {};
    }
  }

  get(fp) {
    return this.#read()[fp];
  }

  set(fp, value) {
    const all = this.#read();
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) if (!v?.at || now - v.at > 24 * 3600 * 1000) delete all[k];
    if (value) all[fp] = { ...value, at: now };
    else delete all[fp];
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
    } catch {
      // A read-only home only costs a new request on the next try.
    }
  }
}

export function statePath(env = process.env) {
  const dir = env.HIBIRA_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'hibira');
  return join(dir, 'approval-hook.json');
}

function gitInfo(cwd) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const remote = git('remote', 'get-url', 'origin').replace(/\/\/[^@/]*@/, '//');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return { remote, branch };
}

function shorten(s, n) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The request a person sees in the Approvals inbox. */
export function requestBody({ agent, command, cwd, session, verdict, settings, git = gitInfo(cwd) }) {
  const name = AGENTS[agent] ?? agent;
  const lines = [`${name} wants to run:`, '', command.length > 4000 ? `${command.slice(0, 4000)}\n…` : command, ''];
  const why = [...new Set(verdict.reasons.map((r) => (r.remote ? `${r.label} (on a remote machine)` : r.label)))];
  lines.push(`Why it asks: ${why.join('; ')}`);
  for (const w of verdict.warnings) lines.push(`⚠ ${w}`);
  lines.push(`Folder: ${cwd}`);
  if (git.remote) lines.push(`Repository: ${git.remote}${git.branch ? ` (${git.branch})` : ''}`);
  let user = '';
  try { user = userInfo().username; } catch { /* no user */ }
  lines.push(`Computer: ${user ? `${user}@` : ''}${hostname()}`);
  if (session) lines.push(`Session: ${String(session).slice(0, 12)}`);
  const body = {
    title: shorten(`${name}: ${command}`, 200),
    details: lines.join('\n'),
    expires_in_minutes: settings.expiresMinutes,
    agent: name,
  };
  if (settings.approvers.length) body.approvers = settings.approvers;
  if (settings.channel) body.channel = settings.channel;
  if (settings.pushInterests.length) body.push_interests = settings.pushInterests;
  else if (settings.pushUsers.length) body.push_users = settings.pushUsers;
  return body;
}

function answeredBy(res) {
  const by = res?.answered_by;
  if (!by) return '';
  return typeof by === 'string' ? by : by.name || by.email || '';
}

/**
 * Decides one hook call. Returns { kind, reason, userMessage }.
 * deps: { approvals, state, settings, now, sleep } for tests.
 */
export async function decideHook({ agent, command, cwd, session }, deps) {
  const { settings } = deps;
  if (!command || !settings.enabled) return { kind: 'pass' };
  const verdict = classifyShell(command, settings);
  if (!verdict.gate) return { kind: 'pass' };
  const what = shorten(verdict.reasons.map((r) => r.label).join('; '), 160);
  const approvals = deps.approvals;
  if (!approvals) {
    return {
      kind: 'deny',
      reason: `This command needs a second person's approval (${what}), but this computer is not connected to a Hibira Approvals workspace yet. ` +
        `Ask the user to run \`${LOGIN}\` in a terminal, or run it yourself in the background and show the user the link and code it prints. ` +
        'Once it says connected, run the same command again. Do not try another way to do the same thing.',
      userMessage: `Hibira Approvals: "${shorten(command, 80)}" needs approval. Connect this computer first: ${LOGIN}`,
    };
  }
  const fp = createHash('sha256').update(JSON.stringify([cwd, command])).digest('hex');
  const state = deps.state;
  let entry = state.get(fp);
  const now = deps.now?.() ?? Date.now();
  if (entry?.status === 'rejected' && now - entry.at < REJECT_MEMORY_MS) return rejected(entry);
  if (entry?.status === 'pending' && entry.expiresAt && Date.parse(entry.expiresAt) <= now) entry = undefined;
  if (entry?.status !== 'pending') entry = undefined;

  let created;
  if (!entry) {
    try {
      created = await approvals.create(requestBody({ agent, command, cwd, session, verdict, settings, git: deps.git }));
    } catch (err) {
      if (err.status === 401) {
        return { kind: 'deny', reason: `Hibira Approvals refused this computer's sign-in (it may have been disconnected). Ask the user to run \`${LOGIN}\` again, then retry the same command.` };
      }
      return { kind: 'deny', reason: `Could not ask for approval (${err.message}), so the command was not run. Tell the user; do not try another way.` };
    }
    entry = { status: 'pending', id: created.approval_id, url: created.url, expiresAt: created.expires_at };
    state.set(fp, entry);
  }

  // Without a workspace or a push/channel, nobody else hears about the
  // request: hand the link to the person at the keyboard and stop waiting.
  const delivered = approvals.notifiesMembers || settings.channel || ((settings.pushInterests.length || settings.pushUsers.length) && !created?.push_error);
  if (!delivered && entry.url) {
    return {
      kind: 'deny',
      reason: `This command waits for approval (${what}). ${agent === 'claude' || agent === 'cursor' ? 'The user was shown the approval link.' : `Give the user this approval link to pass to whoever approves: ${entry.url}`} ` +
        'Do not try another way to do the same thing. When the user says it was approved, run exactly the same command again.',
      userMessage: `Hibira Approvals: "${shorten(command, 80)}" waits for approval. Send this link to whoever approves: ${entry.url}`,
    };
  }

  const deadline = now + settings.waitSeconds * 1000;
  for (;;) {
    let res;
    const left = Math.ceil((deadline - (deps.now?.() ?? Date.now())) / 1000);
    try {
      res = await approvals.get(entry.id, Math.max(0, Math.min(25, left)));
    } catch (err) {
      if (err.status === 404) {
        state.set(fp, undefined);
        return { kind: 'deny', reason: 'The approval request is gone. Run the same command again to ask again.' };
      }
      if ((deps.now?.() ?? Date.now()) >= deadline) break;
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(2000);
      continue;
    }
    const status = res?.status;
    if (status === 'approved') {
      state.set(fp, undefined);
      const by = answeredBy(res);
      return { kind: 'approved', userMessage: `Hibira Approvals: approved${by ? ` by ${by}` : ''}.` };
    }
    if (status === 'rejected') {
      const r = { status: 'rejected', by: answeredBy(res), comment: res.comment, choice: res.choice };
      state.set(fp, r);
      return rejected(r);
    }
    if (status === 'expired' || status === 'cancelled') {
      state.set(fp, undefined);
      return { kind: 'deny', reason: 'Nobody approved this command before the request expired, so it was not run. Tell the user; run it again only if they ask.' };
    }
    if ((deps.now?.() ?? Date.now()) >= deadline) break;
  }
  return {
    kind: 'deny',
    reason: `This command is waiting for a second person to approve it in Hibira Approvals (${what}); nobody has answered yet. ` +
      'Do not try another way to do the same thing. Tell the user it is waiting; when they say it was approved, run exactly the same command again.',
    userMessage: `Hibira Approvals: still waiting for someone to approve "${shorten(command, 80)}".`,
  };
}

function rejected(r) {
  const by = r.by ? ` (${r.by})` : '';
  const comment = r.comment ? `: "${r.comment}"` : '';
  return {
    kind: 'deny',
    reason: `A supervisor${by} rejected this command in Hibira Approvals${comment}. Do not run it, or anything that does the same thing another way. Stop and tell the user.`,
    userMessage: `Hibira Approvals: rejected${by}${comment}.`,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHook(argv, env = process.env) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === 'check') {
    const rest = argv.slice(1);
    const command = rest[0] === '--' ? rest.slice(1).join(' ') : rest.join(' ');
    const settings = loadSettings(env);
    const v = classifyShell(command, settings);
    process.stdout.write(v.gate ? `asks for approval: ${v.reasons.map((r) => r.label).join('; ')}\n` : 'runs without asking\n');
    return;
  }
  const client = argv[0] && argv[0] in AGENTS ? argv[0] : undefined;
  let agent = client ?? 'claude';
  let out;
  try {
    const input = readInput(JSON.parse(await readStdin()), client);
    agent = input.agent ?? agent;
    const settings = loadSettings(env, input.cwd);
    const needs = input.command && settings.enabled && classifyShell(input.command, settings).gate;
    const decision = needs
      ? await decideHook(input, { settings, approvals: approvalsFromEnv(env, settings), state: new State(statePath(env)) })
      : { kind: 'pass' };
    out = render(agent, decision);
  } catch (err) {
    // Fail closed: a broken hook must not let a risky command through.
    out = render(agent, { kind: 'deny', reason: `The Hibira approval hook failed (${err.message}). Tell the user.` });
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}
