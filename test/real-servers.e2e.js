// Runs the gate (through bin.js) in front of real database MCP servers
// against a local Postgres, with the fake Hibira API. Opt-in:
//   DATABASE_URL=postgres://... node --test test/real-servers.e2e.js
// Needs npx (@bytebase/dbhub) and uvx (postgres-mcp).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeHibira } from './fixtures/fake-hibira.js';

const DSN = process.env.DATABASE_URL;
const bin = fileURLToPath(new URL('../bin.js', import.meta.url));
const servers = {
  dbhub: ['npx', '-y', '@bytebase/dbhub@1.6.1', '--transport', 'stdio', '--dsn', DSN],
  // POSTGRES_MCP_CMD overrides the command, e.g. to pin dependencies.
  'postgres-mcp': [...(process.env.POSTGRES_MCP_CMD?.split(' ') ?? ['uvx', 'postgres-mcp']), '--access-mode=unrestricted'],
};
let hibira;
before(async () => { hibira = await fakeHibira(); });
after(async () => { await hibira?.close(); });

const psql = (sql) => execFileSync('psql', [DSN, '-At', '-c', sql]).toString().trim();
const text = (r) => r.content.map((c) => c.text).join('\n');

for (const [name, command] of Object.entries(servers)) {
  test(`${name} behind the gate`, { skip: !DSN && 'set DATABASE_URL', timeout: 180_000 }, async () => {
    psql('DROP TABLE IF EXISTS gate_orders; CREATE TABLE gate_orders (id int primary key, status text); INSERT INTO gate_orders VALUES (1042, \'paid\'), (1043, \'paid\')');
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bin, '--label', 'shop', '--wait', '20', '--', ...command],
      env: { ...process.env, DATABASE_URI: DSN, HIBIRA_APP_ID: 'app_1', HIBIRA_KEY: 'k', HIBIRA_SECRET: 's', HIBIRA_API_URL: hibira.base },
      stderr: 'ignore',
    }));
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'execute_sql'), tools.map((t) => t.name).join());
      const n = hibira.created.length;
      const read = await client.callTool({ name: 'execute_sql', arguments: { sql: 'SELECT status FROM gate_orders WHERE id = 1042' } });
      assert.ok(!read.isError, text(read));
      assert.match(text(read), /paid/);
      assert.equal(hibira.created.length, n, 'a read asks nobody');

      const upd = client.callTool({ name: 'execute_sql', arguments: { sql: "UPDATE gate_orders SET status = 'refunded' WHERE id = 1042" } });
      while (hibira.created.length === n) await new Promise((r) => setTimeout(r, 50));
      assert.equal(psql('SELECT status FROM gate_orders WHERE id = 1042'), 'paid', 'not before approval');
      hibira.decide(hibira.created.at(-1).id, 'Approve');
      const r = await upd;
      assert.ok(!r.isError, text(r));
      assert.equal(psql('SELECT status FROM gate_orders WHERE id = 1042'), 'refunded');

      const del = client.callTool({ name: 'execute_sql', arguments: { sql: 'DELETE FROM gate_orders' } });
      while (hibira.created.length === n + 1) await new Promise((r) => setTimeout(r, 50));
      hibira.decide(hibira.created.at(-1).id, 'Reject');
      assert.equal((await del).isError, true);
      assert.equal(psql('SELECT count(*) FROM gate_orders'), '2');
    } finally {
      await client.close();
    }
  });
}
