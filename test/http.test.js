import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fakeHibira } from './fixtures/fake-hibira.js';

const bin = fileURLToPath(new URL('../bin.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-db-server.js', import.meta.url));
const port = 18000 + Math.floor(Math.random() * 1000);
let hibira, child;

before(async () => {
  hibira = await fakeHibira();
  child = spawn(process.execPath, [bin, '--http', '--port', String(port), '--wait', '0', '--', process.execPath, fixture], {
    env: { ...process.env, HIBIRA_APP_ID: 'app_1', HIBIRA_KEY: 'k', HIBIRA_SECRET: 's', HIBIRA_API_URL: hibira.base, GATE_TOKEN: 'tok123' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => String(d).includes('serving MCP') && resolve());
    child.on('exit', (c) => reject(new Error(`exited ${c}`)));
  });
});
after(async () => {
  child.kill();
  await hibira.close();
});

test('HTTP needs the token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const bad = await fetch(`http://127.0.0.1:${port}/mcp/nope`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 401);
});

for (const [how, url, headers] of [
  ['token in the path', `/mcp/tok123`, {}],
  ['bearer header', `/mcp`, { Authorization: 'Bearer tok123' }],
]) {
  test(`HTTP session with ${how}`, async () => {
    const client = new Client({ name: 'http', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${url}`), { requestInit: { headers } }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'check_approval'));
    const r = await client.callTool({ name: 'execute_sql', arguments: { sql: 'SELECT 42' } });
    assert.match(r.content[0].text, /ran: SELECT 42/);
    const w = await client.callTool({ name: 'execute_sql', arguments: { sql: `DELETE FROM t WHERE k = '${how}'` } });
    assert.match(w.content[0].text, /Approval link/);
    await client.close();
  });
}
