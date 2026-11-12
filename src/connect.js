// Connecting the gate to a Hibira Approvals workspace without keys: a device
// sign-in (like `gh auth login`) gives the gate a workspace token that can
// only ask for and read approvals. The token is kept in a local file.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://approvals.hibira.io';

/** Where tokens are kept: $HIBIRA_CONFIG_DIR, $XDG_CONFIG_HOME/hibira or ~/.config/hibira. */
export function configPath(env = process.env) {
  const dir = env.HIBIRA_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hibira');
  return join(dir, 'approval-gate.json');
}

export class TokenStore {
  constructor(path) {
    this.path = path;
  }

  #all() {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      return data && typeof data === 'object' && data.profiles ? data : { profiles: {} };
    } catch {
      return { profiles: {} };
    }
  }

  get(profile) {
    return this.#all().profiles[profile];
  }

  set(profile, value) {
    const all = this.#all();
    if (value) all.profiles[profile] = value;
    else delete all.profiles[profile];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

async function call(f, url, { method = 'GET', token, body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) {
    const code = json?.error ?? json?.message ?? text.slice(0, 200);
    const err = new Error(`Hibira approvals API ${res.status}: ${json?.error_description ?? json?.message ?? code}`);
    err.status = res.status;
    err.code = json?.error;
    throw err;
  }
  return json;
}

/** Approvals client for a connected workspace (bearer token). Same shape as ApprovalsClient. */
export class WorkspaceClient {
  constructor({ token, baseUrl = DEFAULT_URL, fetch: f = globalThis.fetch }) {
    if (!token) throw new Error('a workspace token is required');
    this.token = token;
    this.notifiesMembers = true;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = f;
  }

  create(body) {
    return call(this.fetch, `${this.baseUrl}/api/v1/gate/requests`, { method: 'POST', token: this.token, body });
  }

  get(id, waitSeconds = 0, signal) {
    const qs = waitSeconds > 0 ? `?wait=${Math.min(25, Math.floor(waitSeconds))}` : '';
    return call(this.fetch, `${this.baseUrl}/api/v1/gate/requests/${encodeURIComponent(id)}${qs}`, { token: this.token, signal });
  }
}

/** The device sign-in: start() gives a code and link, wait() polls until it is connected. */
export class DeviceLogin {
  constructor({ baseUrl = DEFAULT_URL, label, fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.label = label;
    this.fetch = f;
    this.sleep = sleep;
  }

  start() {
    return call(this.fetch, `${this.baseUrl}/api/v1/gate/device`, {
      method: 'POST',
      body: { client: 'mcp-approval-gate', label: this.label || 'database', host: hostname().slice(0, 100) },
    });
  }

  /** Polls until the person connects a workspace. Resolves { access_token, workspace }. */
  async wait(start, signal) {
    let interval = Math.max(1, Number(start.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('cancelled');
      await this.sleep(interval);
      try {
        return await call(this.fetch, `${this.baseUrl}/api/v1/gate/token`, {
          method: 'POST', body: { device_code: start.device_code }, signal,
        });
      } catch (err) {
        if (err.code === 'authorization_pending') continue;
        if (err.code === 'slow_down') { interval += 5000; continue; }
        if (err.code === 'access_denied') throw new Error('the sign-in was cancelled');
        if (err.code === 'expired_token') break;
        if (err.status && err.status < 500) throw err;
      }
    }
    throw new Error('the sign-in code expired');
  }
}

export class NotConnectedError extends Error {
  constructor(login) {
    super('not connected to a Hibira Approvals workspace');
    this.login = login;
  }
}

/**
 * Approvals that connect on first use. With a stored token it is a
 * WorkspaceClient; without one, create() starts a device sign-in (once),
 * throws NotConnectedError with its link, and finishes in the background.
 */
export class ConnectingApprovals {
  constructor({ store, profile = 'default', baseUrl = DEFAULT_URL, label, fetch: f = globalThis.fetch, log = () => {}, sleep }) {
    this.store = store;
    this.profile = profile;
    this.notifiesMembers = true;
    this.baseUrl = baseUrl;
    this.label = label;
    this.fetch = f;
    this.log = log;
    this.sleep = sleep;
    this.client = undefined;
    this.login = undefined;
    const saved = store.get(profile);
    if (saved?.token) this.#use(saved);
  }

  get connected() {
    return Boolean(this.client);
  }

  get workspace() {
    return this.saved?.workspace;
  }

  #use(saved) {
    this.saved = saved;
    this.client = new WorkspaceClient({ token: saved.token, baseUrl: saved.url || this.baseUrl, fetch: this.fetch });
  }

  /** Starts (or reuses) a device sign-in and returns its code and link. */
  async connect() {
    if (this.client) return undefined;
    const now = Date.now();
    if (this.login && this.login.expiresAt > now) return this.login;
    const flow = new DeviceLogin({ baseUrl: this.baseUrl, label: this.label, fetch: this.fetch, sleep: this.sleep });
    const start = await flow.start();
    const login = {
      code: start.user_code,
      url: start.verification_uri_complete || start.verification_uri,
      verificationUri: start.verification_uri,
      expiresAt: now + (Number(start.expires_in) || 900) * 1000,
    };
    this.login = login;
    this.log(`connect this gate: open ${login.url} and enter ${login.code}`);
    login.done = flow.wait(start).then((res) => {
      const saved = { token: res.access_token, workspace: res.workspace, url: this.baseUrl, connected_at: new Date().toISOString() };
      this.store.set(this.profile, saved);
      this.#use(saved);
      this.login = undefined;
      this.log(`connected to workspace ${res.workspace?.name ?? res.workspace?.id ?? ''}`.trim());
      return saved;
    }, (err) => {
      if (this.login === login) this.login = undefined;
      this.log(`connecting failed: ${err.message}`);
      throw err;
    });
    login.done.catch(() => {});
    return login;
  }

  async create(body) {
    if (!this.client) throw new NotConnectedError(await this.connect());
    try {
      return await this.client.create(body);
    } catch (err) {
      if (err.status === 401) this.#revoked();
      throw err;
    }
  }

  async get(id, waitSeconds, signal) {
    if (!this.client) throw new NotConnectedError(await this.connect());
    try {
      return await this.client.get(id, waitSeconds, signal);
    } catch (err) {
      if (err.status === 401) this.#revoked();
      throw err;
    }
  }

  #revoked() {
    this.log('the workspace token was revoked; the next change will ask to connect again');
    this.store.set(this.profile, undefined);
    this.client = undefined;
    this.saved = undefined;
  }
}
