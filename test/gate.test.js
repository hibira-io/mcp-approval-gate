import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Gate } from '../src/gate.js';
import { ApprovalsClient } from '../src/hibira.js';
import { fakeHibira } from './fixtures/fake-hibira.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-db-server.js', import.meta.url));
let hibira, upstream;

before(async () => {
  hibira = await fakeHibira();
  upstream = new Client({ name: 't', version: '1' });
  await upstream.connect(new StdioClientTransport({ command: process.execPath, args: [fixture] }));
});
after(async () => {
  await upstream.close();
  await hibira.close();
});

async function connect(opts = {}) {
  const approvals = new ApprovalsClient({ appId: 'app_1', key: 'k', secret: 's', baseUrl: hibira.base });
  const gate = new Gate({ upstream, approvals, label: 'shop-db', waitSeconds: 2, pushInterests: ['ops'], ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gate.createServer().connect(a);
  const client = new Client({ name: 'c', version: '1' });
  await client.connect(b);
  return { gate, client };
}

const text = (r) => r.content.map((c) => c.text).join('\n');
const ran = async (client) => JSON.parse(text(await client.callTool({ name: 'ran_log', arguments: {} })));

test('lists upstream tools plus check_approval, with notes', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['check_approval', 'execute_sql', 'list_tables', 'pause_project', 'ran_log']);
  assert.match(tools.find((t) => t.name === 'execute_sql').description, /Read-only SQL runs right away/);
  assert.match(tools.find((t) => t.name === 'pause_project').description, /supervisor/);
  assert.equal(tools.find((t) => t.name === 'list_tables').description, 'List tables');
  const { instructions } = { instructions: client.getInstructions() };
  assert.match(instructions, /supervisor/);
});

test('reads pass through without an approval', async () => {
  const { client } = await connect();
  const before = hibira.created.length;
  const r = await client.callTool({ name: 'execute_sql', arguments: { sql: 'SELECT 1' } });
  assert.equal(text(r), 'ran: SELECT 1');
  assert.equal(hibira.created.length, before);
});

test('a write waits, then runs once after approval', async () => {
  const { client } = await connect();
  const sql = "UPDATE orders SET status = 'refunded' WHERE id = 1042";
  const call = client.callTool({ name: 'execute_sql', arguments: { sql } });
  await new Promise((r) => setTimeout(r, 150));
  const req = hibira.created.at(-1);
  assert.equal(req.body.title, 'UPDATE on shop-db');
  assert.match(req.body.details, /UPDATE orders SET status/);
  assert.match(req.body.details, /Fingerprint: [0-9a-f]{16}/);
  assert.deepEqual(req.body.push_interests, ['ops']);
  assert.ok(!(await ran(client)).includes(sql), 'nothing runs before approval');
  hibira.decide(req.id, 'Approve');
  const r = await call;
  assert.match(text(r), /ran: UPDATE orders/);
  assert.match(text(r), /Approved by a supervisor/);
  assert.equal((await ran(client)).filter((s) => s === sql).length, 1);
});

test('a declined write never runs', async () => {
  const { client } = await connect();
  const sql = 'DELETE FROM users';
  const call = client.callTool({ name: 'execute_sql', arguments: { sql } });
  await new Promise((r) => setTimeout(r, 150));
  const req = hibira.created.at(-1);
  assert.match(req.body.details, /without WHERE/);
  hibira.decide(req.id, 'Reject', 'not on prod');
  const r = await call;
  assert.equal(r.isError, true);
  assert.match(text(r), /Reject.*did not run.*not on prod/s);
  assert.ok(!(await ran(client)).includes(sql));
});

test('pending past the wait: answers with the link, check_approval runs it later', async () => {
  const { client } = await connect({ waitSeconds: 0, pushInterests: [] });
  const sql = 'INSERT INTO t VALUES (7)';
  const r = await client.callTool({ name: 'execute_sql', arguments: { sql } });
  assert.ok(!r.isError);
  assert.match(text(r), /Approval link: https:\/\/hibira\.test\/approve\//);
  const id = /approval_id: (apr_\d+)/.exec(text(r))[1];
  // Same call again reuses the same request.
  const again = await client.callTool({ name: 'execute_sql', arguments: { sql } });
  assert.match(text(again), new RegExp(`approval_id: ${id}`));
  hibira.decide(id, 'Approve');
  const done = await client.callTool({ name: 'check_approval', arguments: { approval_id: id } });
  assert.match(text(done), /ran: INSERT INTO t VALUES \(7\)/);
  // The approval is used up.
  const twice = await client.callTool({ name: 'check_approval', arguments: { approval_id: id } });
  assert.equal(twice.isError, true);
  assert.equal((await ran(client)).filter((s) => s === sql).length, 1);
});

test('approval binds the exact call: a changed statement needs a new approval', async () => {
  const { client } = await connect({ waitSeconds: 0 });
  const a = await client.callTool({ name: 'execute_sql', arguments: { sql: 'DELETE FROM t WHERE id = 1' } });
  const b = await client.callTool({ name: 'execute_sql', arguments: { sql: 'DELETE FROM t WHERE id > 0' } });
  const ida = /approval_id: (apr_\d+)/.exec(text(a))[1];
  const idb = /approval_id: (apr_\d+)/.exec(text(b))[1];
  assert.notEqual(ida, idb);
  hibira.decide(ida, 'Approve');
  const r = await client.callTool({ name: 'check_approval', arguments: { approval_id: ida } });
  assert.match(text(r), /ran: DELETE FROM t WHERE id = 1/);
  assert.ok(!(await ran(client)).includes('DELETE FROM t WHERE id > 0'));
});

test('non-SQL tools marked as writing are gated; expiry stops them', async () => {
  const { client } = await connect();
  const call = client.callTool({ name: 'pause_project', arguments: { project_id: 'p1' } });
  await new Promise((r) => setTimeout(r, 150));
  const req = hibira.created.at(-1);
  assert.equal(req.body.title, 'pause_project on shop-db');
  hibira.expire(req.id);
  const r = await call;
  assert.equal(r.isError, true);
  assert.match(text(r), /Nobody answered in time/);
  assert.ok(!(await ran(client)).includes('pause p1'));
});

test('when the approvals API fails, nothing runs', async () => {
  const approvals = new ApprovalsClient({ appId: 'app_1', key: 'k', secret: 'wrong', baseUrl: hibira.base });
  const gate = new Gate({ upstream, approvals, waitSeconds: 1 });
  const r = await gate.callTool({ name: 'execute_sql', arguments: { sql: 'DROP TABLE x' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Could not ask for approval.*401/s);
});

test('with push or a channel, the assistant never gets the link', async () => {
  for (const opts of [{ pushInterests: ['ops'] }, { pushInterests: [], channel: 'private-approvals' }]) {
    const { client } = await connect({ waitSeconds: 0, ...opts });
    const r = await client.callTool({ name: 'execute_sql', arguments: { sql: `DELETE FROM t WHERE id = ${Math.random()}` } });
    assert.match(text(r), /supervisor has been notified/);
    assert.doesNotMatch(text(r), /https?:\/\//);
    assert.equal(r._meta['io.hibira/approval'].url, undefined);
    assert.equal(hibira.created.at(-1).body.channel, opts.channel);
  }
  const { client } = await connect({ waitSeconds: 0, showLink: 'always' });
  const r = await client.callTool({ name: 'execute_sql', arguments: { sql: 'DELETE FROM t WHERE id = 99' } });
  assert.match(text(r), /Approval link: https:/);
});
