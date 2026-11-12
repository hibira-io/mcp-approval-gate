// A small client for the Hibira approvals HTTP API, signed with the app's
// key and secret like the Pusher HTTP API.

import { createHash, createHmac } from 'node:crypto';

export class ApprovalsClient {
  /**
   * @param {{ appId: string, key: string, secret: string, baseUrl?: string, fetch?: typeof fetch }} opts
   */
  constructor({ appId, key, secret, baseUrl = 'https://ws.hibira.io', fetch: f = globalThis.fetch }) {
    if (!appId || !key || !secret) throw new Error('HIBIRA_APP_ID, HIBIRA_KEY and HIBIRA_SECRET are required');
    this.appId = appId;
    this.key = key;
    this.secret = secret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = f;
  }

  /** Creates an approval request. Returns the API's answer (approval_id, url, status...). */
  create(body) {
    return this.#request('POST', `/apps/${encodeURIComponent(this.appId)}/approvals`, {}, body);
  }

  /** Reads one request, waiting up to waitSeconds (0-25) for an answer. */
  get(id, waitSeconds = 0, signal) {
    const qs = waitSeconds > 0 ? { wait: String(Math.min(25, Math.floor(waitSeconds))) } : {};
    return this.#request('GET', `/apps/${encodeURIComponent(this.appId)}/approvals/${encodeURIComponent(id)}`, qs, undefined, signal);
  }

  async #request(method, path, query, body, signal) {
    const qs = { ...query, auth_key: this.key, auth_timestamp: String(Math.floor(Date.now() / 1000)), auth_version: '1.0' };
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data !== undefined) qs.body_md5 = createHash('md5').update(data).digest('hex');
    const canonical = Object.keys(qs).sort().map((k) => `${k}=${qs[k]}`).join('&');
    qs.auth_signature = createHmac('sha256', this.secret).update(`${method}\n${new URL(this.baseUrl + path).pathname}\n${canonical}`).digest('hex');
    const url = `${this.baseUrl}${path}?${new URLSearchParams(qs)}`;
    const res = await this.fetch(url, {
      method,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data,
      signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok) {
      const msg = json?.error ?? json?.message ?? text.slice(0, 200);
      const err = new Error(`Hibira approvals API ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
}
