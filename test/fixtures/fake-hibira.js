// A stand-in for the Hibira approvals API that checks signatures.
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

export async function fakeHibira({ appId = 'app_1', key = 'k', secret = 's' } = {}) {
  const approvals = new Map();
  const created = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const qs = Object.fromEntries(url.searchParams);
    const sig = qs.auth_signature;
    delete qs.auth_signature;
    if (body) {
      if (qs.body_md5 !== createHash('md5').update(body).digest('hex')) return send(res, 401, { error: 'bad body_md5' });
    }
    const canonical = Object.keys(qs).sort().map((k) => `${k}=${qs[k]}`).join('&');
    const want = createHmac('sha256', secret).update(`${req.method}\n${url.pathname}\n${canonical}`).digest('hex');
    if (sig !== want || qs.auth_key !== key) return send(res, 401, { error: 'invalid signature' });
    const create = url.pathname === `/apps/${appId}/approvals` && req.method === 'POST';
    const get = /^\/apps\/[^/]+\/approvals\/([^/]+)$/.exec(url.pathname);
    if (create) {
      const b = JSON.parse(body);
      const id = `apr_${++n}`;
      const a = { approval_id: id, app_id: appId, title: b.title, options: b.options ?? ['Approve', 'Reject'], status: 'pending', url: `https://hibira.test/approve/${id}/tok` };
      approvals.set(id, a);
      created.push({ id, body: b });
      return send(res, 201, a);
    }
    if (get && req.method === 'GET') {
      const a = approvals.get(get[1]);
      if (!a) return send(res, 404, { error: 'no approval' });
      const wait = Number(qs.wait ?? 0);
      const until = Date.now() + Math.min(wait, 1) * 1000;
      while (a.status === 'pending' && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      return send(res, 200, a);
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, created,
    decide(id, choice, comment) {
      const a = approvals.get(id);
      a.choice = choice;
      a.status = choice === a.options[0] ? 'approved' : 'rejected';
      if (comment) a.comment = comment;
    },
    expire(id) { approvals.get(id).status = 'expired'; },
    close: () => new Promise((r) => server.close(r)),
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}
