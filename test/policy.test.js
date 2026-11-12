import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, fingerprint, sqlArguments } from '../src/policy.js';

test('SQL arguments decide SQL tools', () => {
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'SELECT 1' } }).gate, false);
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'DELETE FROM t' } }).gate, true);
  // Supabase: execute_sql and apply_migration take "query".
  assert.equal(decide({ name: 'execute_sql', args: { project_id: 'p', query: 'select 1' } }).gate, false);
  assert.equal(decide({ name: 'apply_migration', args: { project_id: 'p', name: 'm', query: 'create table x (id int)' } }).gate, true);
  // A read-only annotation does not let a write through.
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'DROP TABLE t' }, tool: { annotations: { readOnlyHint: true } } }).gate, true);
  // postgres-mcp explain_query with analyze on a write.
  assert.equal(decide({ name: 'explain_query', args: { sql: 'DELETE FROM t', analyze: true } }).gate, true);
});

test('non-SQL tools: annotations, then names', () => {
  assert.equal(decide({ name: 'pause_project', args: {}, tool: { annotations: { readOnlyHint: false } } }).gate, true);
  assert.equal(decide({ name: 'weird_tool', args: {}, tool: { annotations: { readOnlyHint: true } } }).gate, false);
  assert.equal(decide({ name: 'list_tables', args: {} }).gate, false);
  assert.equal(decide({ name: 'search_objects', args: {} }).gate, false);
  assert.equal(decide({ name: 'analyze_db_health', args: {} }).gate, false);
  assert.equal(decide({ name: 'deploy_edge_function', args: {} }).gate, true);
  assert.equal(decide({ name: 'mystery', args: {} }).gate, true);
});

test('modes and lists', () => {
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'SELECT 1' }, mode: 'all' }).gate, true);
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'DROP TABLE t' }, mode: 'none' }).gate, false);
  assert.equal(decide({ name: 'list_tables', args: {}, gateTools: ['list_*'] }).gate, true);
  assert.equal(decide({ name: 'execute_sql', args: { sql: 'DROP TABLE t' }, allowTools: ['execute_sql'] }).gate, false);
});

test('fingerprint ignores key order, sees value changes', () => {
  assert.equal(fingerprint('t', { a: 1, b: 2 }), fingerprint('t', { b: 2, a: 1 }));
  assert.notEqual(fingerprint('t', { sql: 'DELETE FROM t WHERE id = 1' }), fingerprint('t', { sql: 'DELETE FROM t WHERE id = 2' }));
  assert.notEqual(fingerprint('a', {}), fingerprint('b', {}));
});

test('sqlArguments', () => {
  assert.deepEqual(sqlArguments({ SQL: 'x', other: 'y', queries: ['a', 1, 'b'] }), ['x', 'a', 'b']);
  assert.deepEqual(sqlArguments(null), []);
});

test('splitCommand and parse', async () => {
  const { splitCommand, parse, childEnv } = await import('../src/cli.js');
  assert.deepEqual(splitCommand(`npx -y @bytebase/dbhub --dsn "postgres://u:p@h/db?sslmode=require" ''`), ['npx', '-y', '@bytebase/dbhub', '--dsn', 'postgres://u:p@h/db?sslmode=require', '']);
  assert.deepEqual(parse([], { GATE_COMMAND: 'uvx postgres-mcp' }).command, ['uvx', 'postgres-mcp']);
  assert.deepEqual(parse(['--label', 'x', '--', 'a', '--b'], {}).command, ['a', '--b']);
  assert.throws(() => parse([], {}), /wrap/);
  assert.throws(() => parse(['--mode', 'some', '--', 'a'], {}), /mode/);
  assert.deepEqual(parse(['--', 'a'], { GATE_UPSTREAM_HEADERS: 'Authorization: Bearer x' }).headers, { Authorization: 'Bearer x' });
  assert.deepEqual(parse(['--header', 'Authorization: Bearer ${TOK}', '--upstream-url', 'https://x/mcp'], { TOK: 'abc' }).headers, { Authorization: 'Bearer abc' });
  const env = childEnv({ HIBIRA_SECRET: 's', HIBIRA_KEY: 'k', GATE_TOKEN: 't', DATABASE_URI: 'd' });
  assert.deepEqual(env, { DATABASE_URI: 'd' });
});
