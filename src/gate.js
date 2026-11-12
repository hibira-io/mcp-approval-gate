// The proxy: one upstream MCP client, shared by every downstream session.
// Reads pass straight through. A call that changes something becomes a
// Hibira approval request; it is forwarded once, with exactly the arguments
// that were approved, after a supervisor approves it.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { decide, fingerprint } from './policy.js';

export const VERSION = '0.1.0';
const DETAILS_MAX = 4000;

export class Gate {
  /**
   * @param {object} opts
   * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} opts.upstream connected client
   * @param {import('./hibira.js').ApprovalsClient} opts.approvals
   * @param {string} [opts.label] the database's name on the approval page
   * @param {'writes'|'all'|'none'} [opts.mode]
   * @param {string[]} [opts.allowTools]
   * @param {string[]} [opts.gateTools]
   * @param {number} [opts.waitSeconds] how long a call waits for the answer before it returns "pending"
   * @param {number} [opts.expiresMinutes]
   * @param {string[]} [opts.pushInterests]
   * @param {string[]} [opts.pushUsers]
   * @param {string} [opts.channel]
   * @param {string[]} [opts.options]
   * @param {number} [opts.upstreamTimeoutMs]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.upstream = opts.upstream;
    this.approvals = opts.approvals;
    this.label = opts.label || 'database';
    this.mode = opts.mode ?? 'writes';
    this.allowTools = opts.allowTools ?? [];
    this.gateTools = opts.gateTools ?? [];
    this.waitSeconds = opts.waitSeconds ?? 50;
    this.expiresMinutes = opts.expiresMinutes ?? 60;
    this.pushInterests = opts.pushInterests ?? [];
    this.pushUsers = opts.pushUsers ?? [];
    this.channel = opts.channel;
    this.options = opts.options;
    this.upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 300_000;
    this.log = opts.log ?? (() => {});
    /** fingerprint -> pending call */
    this.pending = new Map();
    /** approval id -> fingerprint */
    this.byId = new Map();
    this.tools = undefined;
    this.servers = new Set();
    this.checkTool = 'check_approval';
    this.upstream.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.tools = undefined;
      for (const s of this.servers) s.sendToolListChanged().catch(() => {});
    });
  }

  /** A downstream MCP server for one client session. */
  createServer() {
    const caps = this.upstream.getServerCapabilities() ?? {};
    const server = new Server(
      { name: 'hibira-mcp-approval-gate', title: 'Approval gate', version: VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          logging: {},
          ...(caps.resources ? { resources: {} } : {}),
          ...(caps.prompts ? { prompts: {} } : {}),
        },
        instructions: this.#instructions(),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, (req, extra) => this.callTool(req.params, extra, server));
    if (caps.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (req) => this.upstream.listResources(req.params));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => this.upstream.listResourceTemplates(req.params));
      server.setRequestHandler(ReadResourceRequestSchema, (req) => this.upstream.readResource(req.params));
    }
    if (caps.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (req) => this.upstream.listPrompts(req.params));
      server.setRequestHandler(GetPromptRequestSchema, (req) => this.upstream.getPrompt(req.params));
    }
    this.servers.add(server);
    server.onclose = () => this.servers.delete(server);
    return server;
  }

  #instructions() {
    const up = this.upstream.getInstructions?.();
    const own = `Calls that change the ${this.label} (writes, schema changes, deletes) wait for a supervisor's approval before they run. ` +
      `If a call answers that it is waiting, give the person the approval link, and call ${this.checkTool} with the approval_id when they say it is decided. ` +
      'Do not rewrite a declined statement to get around the decision.';
    return up ? `${up}\n\n${own}` : own;
  }

  /** Upstream tools, plus the gate's own check tool. */
  async listTools() {
    if (!this.tools) {
      const tools = [];
      let cursor;
      do {
        const page = await this.upstream.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.tools = tools;
      if (tools.some((t) => t.name === this.checkTool)) this.checkTool = 'approval_gate_check';
    }
    return [...this.tools.map((t) => this.#describe(t)), this.#checkToolDef()];
  }

  #describe(tool) {
    const d = decide({ name: tool.name, args: {}, tool, mode: this.mode, allowTools: this.allowTools, gateTools: this.gateTools });
    const sqlTool = Object.keys(tool.inputSchema?.properties ?? {}).some((k) => ['sql', 'query', 'statement', 'statements', 'sql_query', 'queries', 'script'].includes(k.toLowerCase()));
    let note;
    if (sqlTool && this.mode === 'writes') note = 'Read-only SQL runs right away; statements that change data or schema wait for a supervisor\'s approval.';
    else if (d.gate) note = 'Waits for a supervisor\'s approval before it runs.';
    if (!note) return tool;
    return { ...tool, description: tool.description ? `${tool.description}\n\n${note}` : note };
  }

  #checkToolDef() {
    return {
      name: this.checkTool,
      title: 'Check approval',
      description: 'Checks a call that is waiting for a supervisor\'s approval. If it was approved, runs it (once) and returns its result; if it was declined or expired, says so. Waits up to 25 seconds for an answer.',
      inputSchema: {
        type: 'object',
        properties: { approval_id: { type: 'string', description: 'The approval_id from the waiting answer (apr_...)' } },
        required: ['approval_id'],
      },
      annotations: { title: 'Check approval', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
  }

  async #toolDef(name) {
    if (!this.tools) await this.listTools();
    return this.tools.find((t) => t.name === name);
  }

  /** Handles tools/call. */
  async callTool(params, extra = {}, server) {
    const { name, arguments: args = {} } = params;
    if (name === this.checkTool) return this.#check(String(args.approval_id ?? ''), extra);
    const tool = await this.#toolDef(name);
    const d = decide({ name, args, tool, mode: this.mode, allowTools: this.allowTools, gateTools: this.gateTools });
    if (!d.gate) return this.#forward(name, args, extra);

    const fp = fingerprint(name, args);
    let entry = this.pending.get(fp);
    if (!entry) {
      let created;
      try {
        created = await this.approvals.create(this.#approvalBody(name, args, d, fp));
      } catch (err) {
        this.log(`approval request failed: ${err.message}`);
        return errorResult(`Could not ask for approval, so nothing ran: ${err.message}`);
      }
      entry = { id: created.approval_id, url: created.url, name, args, fp, expiresAt: created.expires_at, pushError: created.push_error };
      this.pending.set(fp, entry);
      this.byId.set(entry.id, fp);
      this.log(`approval ${entry.id} requested for ${name} (${d.reason}): ${entry.url}`);
    }
    await notify(server, extra, `Waiting for supervisor approval: ${entry.url}`);
    return this.#await(entry, this.waitSeconds, extra);
  }

  #approvalBody(name, args, d, fp) {
    const sql = d.sql;
    const what = sql?.kinds?.length ? sql.kinds.join(', ') : name;
    const title = truncate(`${what} on ${this.label}`, 200);
    const lines = [];
    lines.push(`Database: ${this.label}`);
    lines.push(`Tool: ${name}`);
    if (sql?.kinds?.length) lines.push(`Changes: ${sql.kinds.join(', ')}`);
    for (const w of sql?.warnings ?? []) lines.push(`⚠ ${w}`);
    lines.push('');
    const body = sql ? sqlText(args) : JSON.stringify(args, null, 2);
    const others = sql ? otherArgs(args) : '';
    const footer = `\n\nFingerprint: ${fp.slice(0, 16)}\nOnly this exact call runs after approval.`;
    let text = lines.join('\n') + body + (others ? `\n\nOther arguments:\n${others}` : '');
    const room = DETAILS_MAX - footer.length;
    if (text.length > room) text = text.slice(0, room - 40) + '\n… (truncated; see the request log)';
    const out = {
      title,
      details: text + footer,
      expires_in_minutes: this.expiresMinutes,
      agent: truncate(`Approval gate · ${this.label}`, 60),
    };
    if (this.options?.length) out.options = this.options;
    if (this.channel) out.channel = this.channel;
    if (this.pushInterests.length) out.push_interests = this.pushInterests;
    else if (this.pushUsers.length) out.push_users = this.pushUsers;
    return out;
  }

  async #await(entry, seconds, extra) {
    const deadline = Date.now() + seconds * 1000;
    let progress = 0;
    for (;;) {
      if (extra.signal?.aborted) return pendingResult(entry, this.checkTool);
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      let state;
      try {
        state = await this.approvals.get(entry.id, Math.min(25, left), extra.signal);
      } catch (err) {
        if (extra.signal?.aborted) return pendingResult(entry, this.checkTool);
        if (err.status === 404) {
          this.#forget(entry);
          return errorResult(`Approval ${entry.id} is gone (it expired more than a day ago). Nothing ran.`);
        }
        this.log(`approval ${entry.id} status failed: ${err.message}`);
        if (Date.now() >= deadline) return pendingResult(entry, this.checkTool);
        await sleep(1000);
        continue;
      }
      if (state.status === 'approved') return this.#run(entry, state, extra);
      if (state.status === 'rejected' || state.status === 'expired') {
        this.#forget(entry);
        const how = state.status === 'expired' ? 'Nobody answered in time' : `The supervisor chose "${state.choice}"`;
        return errorResult(`${how}, so the call did not run.${state.comment ? ` Comment: ${state.comment}` : ''} Do not retry it unless the person asks.`);
      }
      if (Date.now() >= deadline) return pendingResult(entry, this.checkTool);
      if (extra._meta?.progressToken !== undefined && extra.sendNotification) {
        progress += 1;
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: extra._meta.progressToken, progress, message: 'Waiting for supervisor approval' },
        }).catch(() => {});
      }
    }
  }

  async #check(id, extra) {
    const fp = this.byId.get(id);
    const entry = fp && this.pending.get(fp);
    if (!entry) return errorResult(`No call is waiting on approval ${id || '(none given)'}: it already ran, was declined, or this gate restarted. Make the call again to ask for a new approval.`);
    return this.#await(entry, 25, extra);
  }

  async #run(entry, state, extra) {
    // An approval runs its call once, even if the call fails or two waits
    // see the answer at the same time.
    if (entry.ran) return errorResult(`Approval ${entry.id} was already used; the call ran once.`);
    entry.ran = true;
    this.#forget(entry);
    this.log(`approval ${entry.id} approved (${state.choice}); running ${entry.name}`);
    const result = await this.#forward(entry.name, entry.args, extra);
    const note = { type: 'text', text: `Approved by a supervisor (${state.choice}${state.comment ? `: ${state.comment}` : ''}); ran once.` };
    return { ...result, content: [...(result.content ?? []), note] };
  }

  #forget(entry) {
    this.pending.delete(entry.fp);
    this.byId.delete(entry.id);
  }

  async #forward(name, args, extra) {
    try {
      return await this.upstream.callTool({ name, arguments: args }, undefined, {
        signal: extra.signal,
        timeout: this.upstreamTimeoutMs,
        ...(extra._meta?.progressToken !== undefined && extra.sendNotification ? {
          onprogress: (p) => extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: extra._meta.progressToken } }).catch(() => {}),
          resetTimeoutOnProgress: true,
        } : {}),
      });
    } catch (err) {
      return errorResult(`The database server failed: ${err.message}`);
    }
  }
}

function sqlText(args) {
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (!['sql', 'query', 'statement', 'statements', 'sql_query', 'queries', 'script'].includes(k.toLowerCase())) continue;
    parts.push(Array.isArray(v) ? v.join(';\n') : String(v));
  }
  return parts.join('\n\n').trim();
}

function otherArgs(args) {
  const rest = Object.entries(args).filter(([k]) => !['sql', 'query', 'statement', 'statements', 'sql_query', 'queries', 'script'].includes(k.toLowerCase()));
  return rest.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

function pendingResult(entry, checkTool) {
  const text = [
    'Waiting for a supervisor to approve this call. Nothing has run yet.',
    `Approval link: ${entry.url}`,
    `approval_id: ${entry.id}`,
    entry.pushError ? `(The push notification failed: ${entry.pushError}. Share the link instead.)` : '',
    `Give the person the link. When they say it is decided, call ${checkTool} with this approval_id; it runs the call if it was approved.`,
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], _meta: { 'io.hibira/approval': { approval_id: entry.id, url: entry.url, status: 'pending' } } };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function notify(server, extra, data) {
  if (!server) return;
  try {
    await server.sendLoggingMessage({ level: 'notice', logger: 'approval-gate', data }, extra.sessionId);
  } catch {
    // Clients that did not ask for logging ignore it.
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
