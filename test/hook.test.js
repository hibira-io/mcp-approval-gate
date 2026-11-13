import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideHook, readInput, render, requestBody, loadSettings } from '../src/hook.js';
import { classifyShell } from '../src/shell.js';

const settings = (over = {}) => ({ ...loadSettings({}, '/nonexistent'), waitSeconds: 60, ...over });

class MemState {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.get(k); }
  set(k, v) { if (v) this.m.set(k, { ...v, at: Date.now() }); else this.m.delete(k); }
}

function fakeApprovals(answers, { notifies = true } = {}) {
  const calls = { create: [], get: [] };
  return {
    calls,
    notifiesMembers: notifies,
    async create(body) { calls.create.push(body); return { approval_id: `apr_${calls.create.length}`, url: 'https://approvals.hibira.io/r/x', status: 'pending', expires_at: new Date(Date.now() + 1800e3).toISOString() }; },
    async get(id, wait) { calls.get.push([id, wait]); return answers.shift() ?? { status: 'pending' }; },
  };
}

const input = { agent: 'claude', command: 'terraform apply', cwd: '/repo', session: 'sess' };
const git = { remote: 'https://github.com/acme/infra.git', branch: 'main' };

test('everyday commands pass without a request', async () => {
  const approvals = fakeApprovals([]);
  const d = await decideHook({ ...input, command: 'terraform plan' }, { settings: settings(), approvals, state: new MemState(), git });
  assert.equal(d.kind, 'pass');
  assert.equal(approvals.calls.create.length, 0);
});

test('approved: runs once, then asks again', async () => {
  const approvals = fakeApprovals([{ status: 'pending' }, { status: 'approved', answered_by: { name: 'Mei', email: 'mei@acme.test' } }]);
  const state = new MemState();
  const d = await decideHook(input, { settings: settings({ approvers: ['ops'] }), approvals, state, git });
  assert.equal(d.kind, 'approved');
  assert.match(d.userMessage, /Mei/);
  const body = approvals.calls.create[0];
  assert.equal(body.agent, 'Claude Code');
  assert.deepEqual(body.approvers, ['ops']);
  assert.match(body.title, /terraform apply/);
  assert.match(body.details, /acme\/infra\.git \(main\)/);
  assert.equal(state.m.size, 0);
  const again = fakeApprovals([{ status: 'approved' }]);
  await decideHook(input, { settings: settings(), approvals: again, state, git });
  assert.equal(again.calls.create.length, 1, 'an approval is good for one run');
});

test('rejected: denied with the comment, and remembered', async () => {
  const approvals = fakeApprovals([{ status: 'rejected', answered_by: 'Mei', comment: 'not during the sale' }]);
  const state = new MemState();
  const d = await decideHook(input, { settings: settings(), approvals, state, git });
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /Mei/);
  assert.match(d.reason, /not during the sale/);
  assert.match(d.reason, /Do not run it/);
  const again = await decideHook(input, { settings: settings(), approvals, state, git });
  assert.equal(again.kind, 'deny');
  assert.equal(approvals.calls.create.length, 1, 'no new request right after a rejection');
});

test('still pending: denied, and the retry waits on the same request', async () => {
  let t = 0;
  const now = () => t;
  const approvals = fakeApprovals([]);
  approvals.get = async (id, wait) => { approvals.calls.get.push([id, wait]); t += wait * 1000 || 1000; return { status: 'pending' }; };
  const state = new MemState();
  const d = await decideHook(input, { settings: settings({ waitSeconds: 30 }), approvals, state, git, now });
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /waiting for a second person/);
  assert.doesNotMatch(d.reason, /https:/, 'the agent never gets the link when the workspace notifies people');
  approvals.get = async () => ({ status: 'approved' });
  const d2 = await decideHook(input, { settings: settings(), approvals, state, git, now });
  assert.equal(d2.kind, 'approved');
  assert.equal(approvals.calls.create.length, 1);
});

test('not connected: tells the agent how to connect', async () => {
  const d = await decideHook(input, { settings: settings(), approvals: undefined, state: new MemState(), git });
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /mcp-approval-gate login/);
});

test('app keys without push: the link goes to the person, not a wait', async () => {
  const approvals = fakeApprovals([], { notifies: false });
  const d = await decideHook(input, { settings: settings(), approvals, state: new MemState(), git });
  assert.equal(d.kind, 'deny');
  assert.match(d.userMessage, /https:\/\/approvals\.hibira\.io/);
  assert.doesNotMatch(d.reason, /https:/);
  assert.equal(approvals.calls.get.length, 0);
});

test('an exhausted quota blocks and says why', async () => {
  const approvals = fakeApprovals([]);
  approvals.create = async () => { throw Object.assign(new Error('approvals_quota'), { status: 402 }); };
  const d = await decideHook(input, { settings: settings(), approvals, state: new MemState(), git });
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /used up/);
});

test('API errors fail closed', async () => {
  const approvals = fakeApprovals([]);
  approvals.create = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
  const d = await decideHook(input, { settings: settings(), approvals, state: new MemState(), git });
  assert.equal(d.kind, 'deny');
});

test('reads Claude Code, Codex and Cursor input', () => {
  assert.deepEqual(readInput({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/a', session_id: 's' }).agent, 'claude');
  assert.equal(readInput({ tool_name: 'Bash', tool_input: { command: 'ls' }, turn_id: 't' }).agent, 'codex');
  assert.equal(readInput({ command: 'ls', cwd: '/a', hook_event_name: 'beforeShellExecution' }).agent, 'cursor');
  assert.equal(readInput({ tool_name: 'Edit', tool_input: { file_path: 'x' } }).command, undefined);
});

test('renders each agent\'s answer', () => {
  assert.equal(render('claude', { kind: 'pass' }), undefined);
  assert.equal(render('codex', { kind: 'pass' }), undefined);
  assert.deepEqual(render('cursor', { kind: 'pass' }), { permission: 'allow' });
  assert.equal(render('codex', { kind: 'deny', reason: 'r' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(render('cursor', { kind: 'deny', reason: 'r', userMessage: 'u' }).agent_message, 'r');
});

test('request body stays inside the API limits', () => {
  const command = `psql -c "${'DELETE FROM t WHERE id = 1; '.repeat(400)}"`;
  const b = requestBody({ agent: 'codex', command, cwd: '/r', verdict: classifyShell(command), settings: settings(), git });
  assert.ok(b.title.length <= 200);
  assert.ok(b.details.length < 6000);
  assert.equal(b.agent, 'Codex');
});

function run(args, stdin, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['bin.js', 'hook', ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

test('end to end: the hook asks a connected workspace and lets an approved command through', async () => {
  const seen = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') return res.end(JSON.stringify({ approval_id: 'apr_1', status: 'pending', url: 'https://x/approve' }));
      polls++;
      res.end(JSON.stringify(polls < 2 ? { status: 'pending' } : { status: 'approved', answered_by: { name: 'Mei' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  mkdirSync(join(dir, 'cfg'));
  writeFileSync(join(dir, 'cfg', 'approval-gate.json'), JSON.stringify({ profiles: { default: { token: 'hgt_test', url: `http://127.0.0.1:${server.address().port}` } } }));
  const env = { HIBIRA_CONFIG_DIR: join(dir, 'cfg'), HIBIRA_STATE_DIR: join(dir, 'state') };
  try {
    const pass = await run([], { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir }, env);
    assert.equal(pass.out, '');
    const ok = await run([], { tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: dir, session_id: 's' }, env);
    assert.equal(ok.code, 0);
    assert.match(JSON.parse(ok.out).systemMessage, /approved by Mei/);
    assert.equal(seen[0].auth, 'Bearer hgt_test');
    assert.equal(seen[0].url, '/api/v1/gate/requests');
    assert.equal(seen[0].body.agent, 'Claude Code');
    const cursor = await run(['cursor'], { command: 'rm -rf node_modules', cwd: dir }, env);
    assert.deepEqual(JSON.parse(cursor.out), { permission: 'allow' });
  } finally {
    server.close();
  }
});
