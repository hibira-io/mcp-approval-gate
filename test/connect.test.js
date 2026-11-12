import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectingApprovals, DeviceLogin, TokenStore, WorkspaceClient, configPath } from '../src/connect.js';

// A fake Hibira: the device flow answers "pending" until approve() is called.
function fakeHibira() {
  const calls = [];
  let approved = false;
  let tokenOk = true;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body, auth: init.headers?.Authorization });
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/api/v1/gate/device') {
      return json(200, { device_code: 'dev_1', user_code: 'ABCD-1234', verification_uri: 'https://approvals.hibira.io/connect', verification_uri_complete: 'https://approvals.hibira.io/connect?code=ABCD-1234', interval: 1, expires_in: 600 });
    }
    if (u.pathname === '/api/v1/gate/token') {
      if (!approved) return json(400, { error: 'authorization_pending' });
      return json(200, { access_token: 'gat_secret', workspace: { id: 'aw_1', name: 'Store managers' } });
    }
    if (u.pathname.startsWith('/api/v1/gate/requests')) {
      if (!tokenOk || init.headers?.Authorization !== 'Bearer gat_secret') return json(401, { error: 'unauthorized' });
      if (init.method === 'POST') return json(201, { approval_id: 'apr_1', url: 'https://hibira.io/approve/apr_1/t', status: 'pending' });
      return json(200, { approval_id: 'apr_1', status: 'pending' });
    }
    return json(404, { error: 'not found' });
  };
  return { f, calls, approve: () => { approved = true; }, revoke: () => { tokenOk = false; } };
}

const tmpStore = () => new TokenStore(join(mkdtempSync(join(tmpdir(), 'gate-')), 'hibira', 'approval-gate.json'));
const fast = () => Promise.resolve();

test('config path follows HIBIRA_CONFIG_DIR, then XDG_CONFIG_HOME', () => {
  assert.equal(configPath({ HIBIRA_CONFIG_DIR: '/x' }), '/x/approval-gate.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/c' }), '/c/hibira/approval-gate.json');
});

test('token store keeps profiles in a private file', () => {
  const store = tmpStore();
  store.set('default', { token: 't' });
  store.set('prod', { token: 'p' });
  assert.equal(store.get('default').token, 't');
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  store.set('default', undefined);
  assert.equal(store.get('default'), undefined);
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).profiles.prod.token, 'p');
});

test('workspace client sends the bearer token', async () => {
  const h = fakeHibira();
  const c = new WorkspaceClient({ token: 'gat_secret', baseUrl: 'https://hibira.test', fetch: h.f });
  const r = await c.create({ title: 'x' });
  assert.equal(r.approval_id, 'apr_1');
  await c.get('apr_1', 30);
  assert.equal(h.calls[1].path, '/api/v1/gate/requests/apr_1?wait=25');
  assert.equal(h.calls[0].auth, 'Bearer gat_secret');
});

test('device login polls through pending until connected', async () => {
  const h = fakeHibira();
  let n = 0;
  const flow = new DeviceLogin({ baseUrl: 'https://hibira.test', label: 'shop', fetch: h.f, sleep: async () => { if (++n === 3) h.approve(); } });
  const start = await flow.start();
  assert.equal(start.user_code, 'ABCD-1234');
  assert.equal(h.calls[0].body.label, 'shop');
  const res = await flow.wait(start);
  assert.equal(res.access_token, 'gat_secret');
  assert.equal(h.calls.filter((c) => c.path === '/api/v1/gate/token').length, 3);
});

test('without a token, the first change asks to connect, then works once connected', async () => {
  const h = fakeHibira();
  const store = tmpStore();
  const logs = [];
  const a = new ConnectingApprovals({ store, baseUrl: 'https://hibira.test', label: 'shop', fetch: h.f, sleep: fast, log: (m) => logs.push(m) });
  assert.equal(a.connected, false);
  const err = await a.create({ title: 'x' }).catch((e) => e);
  assert.ok(err.login, 'NotConnectedError with the login');
  assert.equal(err.login.code, 'ABCD-1234');
  // A second call while signing in reuses the same code.
  const again = await a.create({ title: 'x' }).catch((e) => e);
  assert.equal(again.login, err.login);
  assert.equal(h.calls.filter((c) => c.path === '/api/v1/gate/device').length, 1);
  h.approve();
  await err.login.done;
  assert.equal(a.connected, true);
  assert.equal(store.get('default').workspace.name, 'Store managers');
  const r = await a.create({ title: 'x' });
  assert.equal(r.approval_id, 'apr_1');
  // A new process picks the saved token up.
  const b = new ConnectingApprovals({ store, baseUrl: 'https://hibira.test', fetch: h.f });
  assert.equal(b.connected, true);
});

test('a revoked token is forgotten', async () => {
  const h = fakeHibira();
  const store = tmpStore();
  store.set('default', { token: 'gat_secret', workspace: { id: 'aw_1' } });
  const a = new ConnectingApprovals({ store, baseUrl: 'https://hibira.test', fetch: h.f });
  h.revoke();
  const err = await a.create({ title: 'x' }).catch((e) => e);
  assert.equal(err.status, 401);
  assert.equal(a.connected, false);
  assert.equal(store.get('default'), undefined);
});
