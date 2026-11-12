// Decides which shell commands from a coding agent wait for a second person's
// approval: deleting files, force pushes, deploys, infrastructure changes,
// publishing packages and database writes. Everything else runs as usual.
//
// The command is split the way a shell would (quotes, ;, &&, ||, |, $( ),
// heredocs), wrappers such as sudo, env, bash -c, ssh and npx are looked
// through, and each simple command is checked on its own. It is a safety net
// for honest mistakes, not a sandbox: an agent that wants to hide a command
// can, so keep real credentials for production out of the agent's reach too.

import { classifySql } from './sql.js';

const OPERATORS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'];

/**
 * Splits a command line into simple commands. Returns
 * [{ argv, heredoc, stdin, pipedFrom }] where heredoc is the body of a
 * <<WORD heredoc, stdin is true when input comes from a file or pipe, and
 * pipedFrom is the previous command of a pipeline.
 */
export function splitShell(line) {
  const out = [];
  let argv = [];
  let word = '';
  let has = false;
  let heredocs = [];
  let cmd = { argv, heredoc: undefined, stdin: false };
  let piped = false;
  let prev;
  const s = String(line ?? '');
  const endWord = () => {
    if (has || word) argv.push(word);
    word = '';
    has = false;
  };
  const endCommand = (op) => {
    endWord();
    if (argv.length) {
      cmd.argv = argv;
      if (piped && prev) {
        cmd.stdin = true;
        cmd.pipedFrom = prev;
      }
      out.push(cmd);
      prev = cmd;
    }
    piped = op === '|' || op === '|&';
    if (!piped) prev = undefined;
    argv = [];
    cmd = { argv, heredoc: undefined, stdin: false };
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] !== '\n') word += s[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      word += end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      has = true;
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          word += s[i + 1];
          i += 2;
        } else if (s[i] === '$' && s[i + 1] === '(') {
          const [inner, next] = balanced(s, i + 2);
          out.push(...splitShell(inner));
          word += `$(${inner})`;
          i = next;
        } else {
          word += s[i++];
        }
      }
      has = true;
      i++;
      continue;
    }
    if (ch === '$' && s[i + 1] === '(') {
      const [inner, next] = balanced(s, i + 2);
      out.push(...splitShell(inner));
      word += `$(${inner})`;
      i = next;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      const inner = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      out.push(...splitShell(inner));
      word += `\`${inner}\``;
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === '#' && !has && !word) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '<' && s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
      endWord();
      let j = i + 2;
      if (s[j] === '-') j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(j));
      if (m) {
        heredocs.push({ cmd, word: m[2] });
        cmd.stdin = true;
        i = j + m[0].length;
        continue;
      }
    }
    if (ch === '<' && s.startsWith('<<<', i)) {
      endWord();
      cmd.stdin = true;
      cmd.herestring = true;
      i += 3;
      continue;
    }
    if (ch === '<' && s[i + 1] !== '(') {
      endWord();
      cmd.stdin = true;
      i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      // Skip the file name.
      while (i < s.length && !/[\s;&|()<>]/.test(s[i])) i++;
      continue;
    }
    if (ch === '>' || (/[0-9]/.test(ch) && s[i + 1] === '>' && !word)) {
      endWord();
      if (ch !== '>') i++;
      i++;
      if (s[i] === '>' || s[i] === '|') i++;
      if (s[i] === '&') {
        i++;
        while (/[0-9-]/.test(s[i] ?? '')) i++;
        continue;
      }
      while (s[i] === ' ' || s[i] === '\t') i++;
      while (i < s.length && !/[\s;&|()<>]/.test(s[i])) i++;
      continue;
    }
    const op = OPERATORS.find((o) => s.startsWith(o, i));
    if (op) {
      if (op === '&' && (s[i + 1] === '>' || s[i - 1] === '>')) {
        i++;
        continue;
      }
      endCommand(op);
      i += op.length;
      if (op === '\n' && heredocs.length) {
        for (const h of heredocs) {
          const lines = [];
          while (i < s.length) {
            let end = s.indexOf('\n', i);
            if (end === -1) end = s.length;
            const l = s.slice(i, end);
            i = end + 1;
            if (l.trim() === h.word) break;
            lines.push(l);
          }
          h.cmd.heredoc = (h.cmd.heredoc ? `${h.cmd.heredoc}\n` : '') + lines.join('\n');
        }
        heredocs = [];
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
      continue;
    }
    word += ch;
    i++;
  }
  endCommand(';');
  return out;
}

function balanced(s, start) {
  let depth = 1;
  let i = start;
  let quote = '';
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') i++;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [s.slice(start, i), i + 1];
    i++;
  }
  return [s.slice(start), s.length];
}

const base = (p) => String(p ?? '').split('/').pop();

// Commands that run the rest of their arguments as another command.
const WRAPPERS = {
  sudo: /^-[ugCDhpRrTt]$|^--(user|group|chdir|host|prompt|role|type|close-from)$/,
  doas: /^-[uC]$/,
  env: /^-[uSC]$|^--(unset|chdir|split-string)$/,
  nohup: null,
  time: /^-[fo]$/,
  nice: /^-n$|^--adjustment$/,
  ionice: /^-[cnp]$/,
  timeout: /^-[sk]$|^--(signal|kill-after)$/,
  command: null,
  exec: /^-a$/,
  builtin: null,
  xargs: /^-[aEeIiLlnPsd]$|^--(arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars)$/,
  watch: /^-[nd]$|^--(interval|differences)$/,
  caffeinate: null,
  stdbuf: null,
  unbuffer: null,
  chronic: null,
  dotenv: /^-[ecv]$/,
  'op': null,
  'aws-vault': null,
};

const RUNNERS = {
  npx: /^-p$|^--package$|^-c$|^--call$/,
  bunx: /^-p$|^--package$/,
  'pnpx': null,
};

/** Drops leading VAR=value words and wrapper commands. Returns the real argv, or the inner shell strings to recurse into. */
function unwrap(argv, depth = 0) {
  let a = argv.slice();
  for (let guard = 0; guard < 20 && a.length; guard++) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    if (!a.length) break;
    const name = base(a[0]);
    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) {
      const c = a.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (c !== -1 && a[c + 1] !== undefined) return { inner: [a[c + 1]] };
      return { argv: a };
    }
    if (name === 'eval') return { inner: [a.slice(1).join(' ')] };
    if (name === 'ssh') {
      const rest = sshCommand(a.slice(1));
      return rest ? { inner: [rest], remote: true } : { argv: a };
    }
    if (name === 'kubectl' && a[1] === 'exec') {
      const d = a.indexOf('--');
      return d !== -1 ? { inner: [a.slice(d + 1).join(' ')], remote: true, argv: a } : { argv: a };
    }
    if (name === 'docker' && (a[1] === 'exec' || a[1] === 'run')) return { argv: a };
    if (name in WRAPPERS) {
      const takesValue = WRAPPERS[name];
      let k = 1;
      if (name === 'timeout' || name === 'watch') {
        while (k < a.length && a[k].startsWith('-')) k += takesValue?.test(a[k]) ? 2 : 1;
        if (name === 'timeout') k++;
      } else if (name === 'op' || name === 'aws-vault' || name === 'dotenv') {
        const d = a.indexOf('--');
        if (d === -1) return { argv: a };
        k = d + 1;
      } else {
        while (k < a.length && a[k].startsWith('-')) {
          if (a[k] === '--') { k++; break; }
          k += takesValue?.test(a[k]) ? 2 : 1;
        }
        if (name === 'env' || name === 'sudo') while (k < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[k])) k++;
      }
      a = a.slice(k);
      continue;
    }
    if (name in RUNNERS || (['pnpm', 'yarn', 'bun'].includes(name) && ['dlx', 'exec', 'x'].includes(a[1])) ||
        (name === 'npm' && ['exec', 'x'].includes(a[1])) || (name === 'bundle' && a[1] === 'exec') ||
        (['poetry', 'uv', 'pipenv', 'rye', 'hatch', 'pdm'].includes(name) && a[1] === 'run') || name === 'uvx' || name === 'pipx' && a[1] === 'run') {
      let k = name in RUNNERS || name === 'uvx' ? 1 : 2;
      const takesValue = RUNNERS[name];
      while (k < a.length && a[k].startsWith('-')) {
        if (a[k] === '--') { k++; break; }
        k += takesValue?.test(a[k]) ? 2 : 1;
      }
      if (k >= a.length) return { argv: a };
      a = a.slice(k);
      // npx package@version -> package
      a[0] = a[0].replace(/^(@?[^@]+)@.*$/, '$1');
      continue;
    }
    break;
  }
  return { argv: a };
}

function sshCommand(args) {
  const valued = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) k += valued.test(args[k]) ? 2 : 1;
  k++; // host
  return k < args.length ? args.slice(k).join(' ') : undefined;
}

// Flag helpers: has(argv, '-f', '--force') also finds combined short flags (-rf).
function hasFlag(argv, short, ...long) {
  return argv.some((w) => long.includes(w) || long.some((l) => w.startsWith(`${l}=`)) ||
    (short && /^-[A-Za-z]+$/.test(w) && !w.startsWith('--') && w.slice(1).includes(short)));
}
const words = (argv) => argv.filter((w) => !w.startsWith('-'));

const SAFE_RM = /^(\.\/)?(node_modules|dist|build|out|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|\.vite|coverage|target|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.tox|tmp|\.tmp|vendor\/bin)\/?$/;

function rmTargetsSafe(targets) {
  return targets.length > 0 && targets.every((t) =>
    !t.includes('..') && !t.includes('*') && (SAFE_RM.test(t) || /^\/tmp\/[^/]+/.test(t) || /^\$\{?TMPDIR\}?\/[^/]+/.test(t) ||
      /^(\.\/)?[\w.-]+\/(node_modules|dist|build|\.next|coverage|target|__pycache__)\/?$/.test(t)));
}

const DEPLOY_SCRIPT = /(^|[:._-])(deploy|release|publish|destroy|teardown|prod|production|rollback|db[:._-]?(reset|drop|wipe|seed[:._-]?prod)|migrate[:._-]?prod)($|[:._-])/i;

const SQL_CLIENTS = {
  psql: { flags: ['-c', '--command'], file: ['-f', '--file'] },
  pgcli: { flags: ['-c', '--command'], file: [] },
  mysql: { flags: ['-e', '--execute'], file: [] },
  mariadb: { flags: ['-e', '--execute'], file: [] },
  sqlite3: { positional: 1, file: [] },
  sqlcmd: { flags: ['-Q', '-q'], file: ['-i'] },
  'clickhouse-client': { flags: ['-q', '--query'], file: ['--queries-file'] },
  clickhouse: { flags: ['-q', '--query'], file: ['--queries-file'] },
  duckdb: { flags: ['-c'], positional: 1, file: [] },
  cqlsh: { flags: ['-e', '--execute'], file: ['-f', '--file'] },
  snowsql: { flags: ['-q', '--query'], file: ['-f', '--filename'] },
  bq: { sub: 'query' },
};

function flagValues(argv, flags) {
  const out = [];
  for (let k = 0; k < argv.length; k++) {
    for (const f of flags) {
      if (argv[k] === f && argv[k + 1] !== undefined) out.push(argv[k + 1]);
      else if (f.startsWith('--') && argv[k].startsWith(`${f}=`)) out.push(argv[k].slice(f.length + 1));
      else if (!f.startsWith('--') && argv[k].startsWith(f) && argv[k].length > f.length && !argv[k].startsWith('--')) out.push(argv[k].slice(f.length));
    }
  }
  return out;
}

function sqlRule(name, argv, cmd) {
  const spec = SQL_CLIENTS[name];
  if (!spec) return undefined;
  let sql = [];
  if (spec.sub) {
    if (argv[1] !== spec.sub) return undefined;
    sql = words(argv.slice(2)).slice(-1);
  } else {
    sql = flagValues(argv, spec.flags ?? []);
    if (!sql.length && spec.positional) {
      const pos = words(argv.slice(1));
      if (pos.length > spec.positional) sql = [pos.slice(spec.positional).join(' ')];
    }
  }
  if (cmd.heredoc) sql.push(cmd.heredoc);
  if (!sql.length && cmd.pipedFrom) {
    const from = cmd.pipedFrom.argv;
    if (['echo', 'printf'].includes(base(from[0]))) sql.push(words(from.slice(1)).join(' '));
    else if (cmd.pipedFrom.heredoc) sql.push(cmd.pipedFrom.heredoc);
  }
  if (cmd.herestring && !sql.length) {
    return { label: `${name} with SQL from a here-string`, kind: 'database' };
  }
  if (sql.length) {
    const c = classifySql(sql.join(';\n'));
    if (!c.write) return undefined;
    return { label: `${name}: ${c.kinds.join(', ')}`, kind: 'database', warnings: c.warnings };
  }
  if (flagValues(argv, spec.file ?? []).length || cmd.stdin) {
    return { label: `${name} runs SQL from a file or pipe`, kind: 'database' };
  }
  return undefined;
}

const REDIS_WRITES = /^(FLUSHALL|FLUSHDB|DEL|UNLINK|SET|MSET|HSET|HDEL|EXPIRE|RENAME|SHUTDOWN|CONFIG|DEBUG|SCRIPT|EVAL|LPUSH|RPUSH|SADD|SREM|ZADD|ZREM|INCR|DECR|XADD|XDEL|MIGRATE|RESTORE|REPLICAOF|SLAVEOF|SWAPDB|MOVE|COPY)$/i;
const MONGO_WRITES = /\.(drop|dropDatabase|delete(One|Many)?|remove|update(One|Many)?|replaceOne|insert(One|Many)?|bulkWrite|findOneAnd(Update|Replace|Delete)|createIndex|dropIndex(es)?|renameCollection)\s*\(/;

/** Rules for one unwrapped simple command. Returns { label, kind } or undefined. */
function rule(argv, cmd) {
  const name = base(argv[0]);
  const sub = argv[1];
  const w = words(argv.slice(1));
  switch (name) {
    case 'rm': {
      if (hasFlag(argv, 'r', '--recursive') || hasFlag(argv, 'R')) {
        if (rmTargetsSafe(w)) return undefined;
        return { label: 'deletes files recursively (rm -r)', kind: 'files' };
      }
      if (w.some((t) => t === '/' || t === '~' || t === '*' || t.startsWith('/') && t.split('/').length <= 2)) return { label: 'deletes files at the top of the disk', kind: 'files' };
      return undefined;
    }
    case 'rmdir': return undefined;
    case 'find':
      if (argv.includes('-delete') || argv.some((x, k) => ['-exec', '-execdir', '-ok'].includes(x) && /^(rm|shred|unlink)$/.test(base(argv[k + 1])))) return { label: 'deletes the files find matches', kind: 'files' };
      return undefined;
    case 'shred': case 'wipefs': case 'srm':
      return { label: `${name} destroys data`, kind: 'files' };
    case 'dd':
      if (argv.some((x) => /^of=\/dev\//.test(x))) return { label: 'dd writes to a disk device', kind: 'files' };
      return undefined;
    case 'truncate':
      return argv.some((x) => /^(-s|--size)(=?0)?$/.test(x)) && argv.includes('0') || argv.some((x) => /^--size=0$|^-s0$/.test(x)) ? { label: 'truncate empties files', kind: 'files' } : undefined;
    case 'shutdown': case 'reboot': case 'halt': case 'poweroff':
      return { label: `${name} the machine`, kind: 'system' };
    case 'systemctl':
      return ['stop', 'disable', 'mask', 'kill', 'poweroff', 'reboot', 'halt'].includes(sub) ? { label: `systemctl ${sub}`, kind: 'system' } : undefined;
    case 'git': return gitRule(argv);
    case 'gh': {
      const [a, b] = w;
      if (a === 'repo' && ['delete', 'archive', 'rename'].includes(b)) return { label: `gh repo ${b}`, kind: 'git' };
      if (a === 'release' && ['create', 'delete', 'delete-asset', 'edit'].includes(b)) return { label: `gh release ${b}`, kind: 'publish' };
      if (a === 'pr' && b === 'merge') return { label: 'merges a pull request', kind: 'git' };
      if (a === 'secret' && ['set', 'delete', 'remove'].includes(b)) return { label: `gh secret ${b}`, kind: 'secrets' };
      if (a === 'variable' && ['set', 'delete'].includes(b)) return { label: `gh variable ${b}`, kind: 'secrets' };
      if (a === 'workflow' && b === 'run') return { label: 'starts a GitHub Actions workflow', kind: 'deploy' };
      if (a === 'api' && argv.some((x, k) => /^(-X|--method)$/.test(x) && /^(DELETE|PUT|PATCH|POST)$/i.test(argv[k + 1] ?? '') || /^(-X|--method=)(DELETE|PUT|PATCH)$/i.test(x))) return { label: 'gh api changes something', kind: 'git' };
      return undefined;
    }
    case 'terraform': case 'tofu': case 'terragrunt': case 'tf': {
      const verbs = ['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'run-all'];
      if (verbs.includes(sub)) {
        if (sub === 'run-all' && !['apply', 'destroy'].includes(argv[2])) return undefined;
        return { label: `${name} ${sub === 'run-all' ? `run-all ${argv[2]}` : sub}`, kind: 'infra' };
      }
      if (sub === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(argv[2])) return { label: `${name} state ${argv[2]}`, kind: 'infra' };
      if (sub === 'workspace' && argv[2] === 'delete') return { label: `${name} workspace delete`, kind: 'infra' };
      return undefined;
    }
    case 'pulumi':
      if (['up', 'update', 'destroy', 'import', 'cancel'].includes(sub) || (sub === 'stack' && argv[2] === 'rm') || (sub === 'state' && ['delete', 'unprotect', 'move'].includes(argv[2])) || (sub === 'refresh' && hasFlag(argv, 'y', '--yes'))) return { label: `pulumi ${w.slice(0, 2).join(' ')}`, kind: 'infra' };
      return undefined;
    case 'cdk': case 'cdktf':
      return ['deploy', 'destroy'].includes(sub) ? { label: `${name} ${sub}`, kind: 'infra' } : undefined;
    case 'serverless': case 'sls':
      return ['deploy', 'remove', 'rollback'].includes(sub) ? { label: `${name} ${sub}`, kind: 'deploy' } : undefined;
    case 'sam':
      return ['deploy', 'delete', 'sync'].includes(sub) ? { label: `sam ${sub}`, kind: 'deploy' } : undefined;
    case 'kubectl': case 'oc': case 'kubecolor': {
      const verbs = ['apply', 'create', 'delete', 'replace', 'patch', 'scale', 'autoscale', 'drain', 'cordon', 'uncordon', 'taint', 'edit', 'set', 'label', 'annotate', 'expose', 'run'];
      const v = w[0];
      if (verbs.includes(v)) return { label: `kubectl ${v}`, kind: 'infra' };
      if (v === 'rollout' && ['restart', 'undo', 'pause', 'resume'].includes(w[1])) return { label: `kubectl rollout ${w[1]}`, kind: 'infra' };
      return undefined;
    }
    case 'helm': case 'helmfile':
      return ['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'apply', 'sync', 'destroy'].includes(sub) ? { label: `${name} ${sub}`, kind: 'infra' } : undefined;
    case 'docker': case 'podman': {
      if (sub === 'push') return { label: `${name} push`, kind: 'publish' };
      if (sub === 'system' && argv[2] === 'prune') return { label: `${name} system prune`, kind: 'files' };
      if (sub === 'volume' && ['rm', 'prune'].includes(argv[2])) return { label: `${name} volume ${argv[2]}`, kind: 'files' };
      if ((sub === 'compose' && argv.includes('down') || name === 'docker-compose' && sub === 'down') && hasFlag(argv, 'v', '--volumes')) return { label: 'compose down removes volumes', kind: 'files' };
      if (sub === 'stack' && ['deploy', 'rm'].includes(argv[2])) return { label: `${name} stack ${argv[2]}`, kind: 'deploy' };
      return undefined;
    }
    case 'docker-compose':
      return sub === 'down' && hasFlag(argv, 'v', '--volumes') ? { label: 'compose down removes volumes', kind: 'files' } : undefined;
    case 'vercel': case 'vc': {
      if (['rm', 'remove', 'promote', 'rollback', 'alias', 'domains'].includes(sub) && !['ls', 'list', 'inspect'].includes(argv[2])) return { label: `vercel ${sub}`, kind: 'deploy' };
      if (sub === 'env' && ['rm', 'add', 'remove', 'pull'].includes(argv[2]) && argv[2] !== 'pull') return { label: `vercel env ${argv[2]}`, kind: 'secrets' };
      if (hasFlag(argv, null, '--prod', '--production') || argv.includes('--target=production') || flagValues(argv, ['--target']).includes('production')) return { label: 'deploys to production (vercel --prod)', kind: 'deploy' };
      return undefined;
    }
    case 'netlify': case 'ntl':
      if (sub === 'deploy' && hasFlag(argv, null, '--prod', '--prodIfUnlocked', '--prod-if-unlocked')) return { label: 'netlify deploy --prod', kind: 'deploy' };
      if (['sites:delete', 'env:unset', 'env:set'].includes(sub)) return { label: `netlify ${sub}`, kind: 'deploy' };
      return undefined;
    case 'fly': case 'flyctl': {
      if (['deploy', 'destroy', 'scale', 'launch'].includes(sub)) return { label: `${name} ${sub}`, kind: 'deploy' };
      if (['apps', 'volumes', 'postgres', 'pg', 'machine', 'machines', 'secrets', 'ips', 'certs'].includes(sub) && ['destroy', 'delete', 'remove', 'rm', 'set', 'unset', 'import', 'release', 'stop', 'restart', 'kill', 'update', 'detach'].includes(argv[2])) return { label: `${name} ${sub} ${argv[2]}`, kind: 'deploy' };
      return undefined;
    }
    case 'wrangler': {
      if (['deploy', 'publish', 'delete', 'rollback'].includes(sub)) return { label: `wrangler ${sub}`, kind: 'deploy' };
      if (sub === 'versions' && argv[2] === 'deploy') return { label: 'wrangler versions deploy', kind: 'deploy' };
      if (sub === 'pages' && argv[2] === 'deploy' && !flagValues(argv, ['--branch']).some((b) => b !== 'main' && b !== 'master' && b !== 'production')) return { label: 'wrangler pages deploy', kind: 'deploy' };
      if (sub === 'secret' && ['put', 'delete', 'bulk'].includes(argv[2])) return { label: `wrangler secret ${argv[2]}`, kind: 'secrets' };
      if (['kv', 'kv:key', 'kv:namespace', 'r2', 'queues', 'd1', 'vectorize', 'hyperdrive'].includes(sub) && argv.some((x) => /^(delete|purge|bulk|put)$/.test(x))) return { label: `wrangler ${sub} delete`, kind: 'database' };
      if (sub === 'd1' && argv[2] === 'execute' && argv.includes('--remote')) {
        const sql = flagValues(argv, ['--command']);
        if (!sql.length) return { label: 'wrangler d1 execute --remote from a file', kind: 'database' };
        const c = classifySql(sql.join(';\n'));
        return c.write ? { label: `wrangler d1 execute --remote: ${c.kinds.join(', ')}`, kind: 'database', warnings: c.warnings } : undefined;
      }
      if (sub === 'd1' && argv[2] === 'migrations' && argv[3] === 'apply' && argv.includes('--remote')) return { label: 'wrangler d1 migrations apply --remote', kind: 'database' };
      return undefined;
    }
    case 'firebase':
      return /^(deploy|hosting:disable|firestore:delete|database:(remove|set|update|push)|functions:delete|auth:import|apps:delete|projects:delete|hosting:channel:delete|ext:install|ext:uninstall)$/.test(sub ?? '') ? { label: `firebase ${sub}`, kind: 'deploy' } : undefined;
    case 'heroku':
      return /^(apps:destroy|destroy|pg:reset|pg:promote|pg:copy|releases:rollback|rollback|config:set|config:unset|ps:scale|scale|maintenance:on|container:release|run)$/.test(sub ?? '') ? { label: `heroku ${sub}`, kind: 'deploy' } : undefined;
    case 'railway':
      return ['up', 'down', 'delete', 'redeploy'].includes(sub) || (sub === 'variables' && argv.includes('--set')) ? { label: `railway ${sub}`, kind: 'deploy' } : undefined;
    case 'render':
      return argv.some((x) => /^(deploy|deploys|restart|delete|suspend)$/.test(x)) && !argv.includes('list') ? { label: `render ${w.slice(0, 2).join(' ')}`, kind: 'deploy' } : undefined;
    case 'gcloud': {
      const v = w.find((x) => /^(deploy|delete|destroy|update|create|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|import|restore|reset|stop|patch|promote-replica|failover|rollback|replace|apply)$/.test(x));
      if (v && !(w.includes('config') && w.includes('set'))) return { label: `gcloud ${w.slice(0, w.indexOf(v) + 1).join(' ')}`, kind: v === 'deploy' ? 'deploy' : 'infra' };
      return undefined;
    }
    case 'gsutil':
      return ['rm', 'rb'].includes(sub) || (sub === 'rsync' && hasFlag(argv, 'd')) ? { label: `gsutil ${sub}`, kind: 'files' } : undefined;
    case 'az': {
      const v = w.find((x) => /^(delete|purge|deploy|up|restart|stop|set|update|create|swap|reset|import|restore|failover)$/.test(x));
      return v && !(w[0] === 'account' && v === 'set') && !(w[0] === 'config') ? { label: `az ${w.slice(0, w.indexOf(v) + 1).join(' ')}`, kind: 'infra' } : undefined;
    }
    case 'aws': {
      const svc = w[0];
      const op = w[1] ?? '';
      if (svc === 's3') {
        if (op === 'rm' || op === 'rb' || op === 'mv') return { label: `aws s3 ${op}`, kind: 'files' };
        if (op === 'sync' && argv.includes('--delete')) return { label: 'aws s3 sync --delete', kind: 'files' };
        if ((op === 'cp' || op === 'sync') && w.slice(2).some((x) => x.startsWith('s3://')) && words(argv).pop()?.startsWith('s3://')) return { label: `aws s3 ${op} uploads to S3`, kind: 'deploy' };
        return undefined;
      }
      if (/^(delete|terminate|remove|put|update|modify|create|deregister|disable|detach|revoke|reboot|stop|restore|reset|deploy|execute|invoke|publish|start|attach|associate|disassociate|import|cancel|purge|run|send|tag|untag|set|replace|promote|failover|rotate|register|enable|apply|change|batch|upload|copy)(-|$)/.test(op) ||
          (svc === 'cloudformation' && op === 'deploy') || svc === 'deploy') {
        return { label: `aws ${svc} ${op}`, kind: 'infra' };
      }
      return undefined;
    }
    case 'eb':
      return ['deploy', 'terminate', 'swap', 'scale', 'setenv', 'restore', 'abort'].includes(sub) ? { label: `eb ${sub}`, kind: 'deploy' } : undefined;
    case 'doctl':
      return w.some((x) => /^(delete|destroy|create-deployment|update|apply|deploy|purge)$/.test(x)) ? { label: `doctl ${w.slice(0, 3).join(' ')}`, kind: 'infra' } : undefined;
    case 'supabase':
      if (sub === 'db' && ['push', 'reset'].includes(argv[2]) && !(argv[2] === 'reset' && !argv.includes('--linked') && !flagValues(argv, ['--db-url']).length)) return { label: `supabase db ${argv[2]}`, kind: 'database' };
      if (sub === 'db' && argv[2] === 'push') return { label: 'supabase db push', kind: 'database' };
      if (['functions', 'secrets', 'projects', 'branches', 'storage'].includes(sub) && /^(deploy|delete|set|unset|rm|mv)$/.test(argv[2] ?? '')) return { label: `supabase ${sub} ${argv[2]}`, kind: 'deploy' };
      if (sub === 'migration' && ['repair', 'up', 'squash'].includes(argv[2]) && (argv.includes('--linked') || flagValues(argv, ['--db-url']).length)) return { label: `supabase migration ${argv[2]}`, kind: 'database' };
      return undefined;
    case 'prisma':
      if (sub === 'migrate' && ['deploy', 'reset', 'resolve'].includes(argv[2])) return { label: `prisma migrate ${argv[2]}`, kind: 'database' };
      if (sub === 'db' && ['push', 'execute', 'seed'].includes(argv[2])) return { label: `prisma db ${argv[2]}`, kind: 'database' };
      return undefined;
    case 'drizzle-kit':
      return ['push', 'migrate', 'drop'].includes(sub) || sub?.startsWith('push:') || sub?.startsWith('drop') ? { label: `drizzle-kit ${sub}`, kind: 'database' } : undefined;
    case 'knex':
      return /^(migrate:(latest|up|down|rollback|unlock)|seed:run)$/.test(sub ?? '') ? { label: `knex ${sub}`, kind: 'database' } : undefined;
    case 'sequelize': case 'sequelize-cli':
      return /^db:(drop|migrate(:undo(:all)?)?|seed(:all|:undo(:all)?)?)$/.test(sub ?? '') ? { label: `sequelize ${sub}`, kind: 'database' } : undefined;
    case 'typeorm':
      return /^(migration:(run|revert)|schema:(drop|sync)|query)$/.test(sub ?? '') ? { label: `typeorm ${sub}`, kind: 'database' } : undefined;
    case 'alembic':
      return ['upgrade', 'downgrade', 'stamp'].includes(sub) ? { label: `alembic ${sub}`, kind: 'database' } : undefined;
    case 'flyway': case 'liquibase':
      return argv.some((x) => /^(migrate|clean|repair|undo|update|rollback|drop-all|dropAll|baseline)/.test(x)) ? { label: `${name} ${w[0]}`, kind: 'database' } : undefined;
    case 'atlas':
      return sub === 'schema' && ['apply', 'clean'].includes(argv[2]) || sub === 'migrate' && ['apply', 'down'].includes(argv[2]) ? { label: `atlas ${sub} ${argv[2]}`, kind: 'database' } : undefined;
    case 'dbmate': case 'goose': case 'migrate':
      return argv.some((x) => /^(up|down|drop|rollback|reset|redo|force|migrate|up-to|down-to|goto)$/.test(x)) ? { label: `${name} ${w.find((x) => /^(up|down|drop|rollback|reset|redo|force|migrate|up-to|down-to|goto)$/.test(x))}`, kind: 'database' } : undefined;
    case 'rails': case 'rake': case 'bin/rails':
      return argv.some((x) => /^db:(drop|reset|migrate|rollback|schema:load|seed|setup|purge|truncate_all|migrate:redo|migrate:down|prepare)$/.test(x)) ? { label: `${name} ${argv.find((x) => x.startsWith('db:'))}`, kind: 'database' } : undefined;
    case 'php': case 'artisan': {
      const a = name === 'artisan' ? argv.slice(1) : base(argv[1]) === 'artisan' ? argv.slice(2) : undefined;
      if (!a) return undefined;
      if (/^(migrate(:fresh|:refresh|:reset|:rollback)?|db:wipe|db:seed|schema:dump|tinker|down|queue:flush|cache:clear|key:generate)$/.test(a[0] ?? '') && !(a[0] === 'migrate' && a.includes('--pretend'))) {
        if (['cache:clear', 'key:generate', 'down', 'tinker'].includes(a[0]) && !a.includes('--force')) return a[0] === 'key:generate' ? { label: 'artisan key:generate replaces the app key', kind: 'secrets' } : undefined;
        return { label: `artisan ${a[0]}`, kind: 'database' };
      }
      return undefined;
    }
    case 'python': case 'python3': case 'manage.py': case 'django-admin': {
      const a = name === 'manage.py' || name === 'django-admin' ? argv.slice(1) : base(argv[1]) === 'manage.py' ? argv.slice(2) : undefined;
      if (a && /^(flush|migrate|loaddata|sqlflush|reset_db|dbshell|createsuperuser)$/.test(a[0] ?? '')) return { label: `manage.py ${a[0]}`, kind: 'database' };
      if (argv[1] === '-m' && argv[2] === 'twine' && argv[3] === 'upload') return { label: 'twine upload', kind: 'publish' };
      return undefined;
    }
    case 'redis-cli': case 'valkey-cli': case 'keydb-cli': {
      const cmdWord = w.find((x) => REDIS_WRITES.test(x));
      if (cmdWord) return { label: `${name} ${cmdWord.toUpperCase()}`, kind: 'database' };
      if (cmd.stdin && !w.length) return { label: `${name} runs commands from a file or pipe`, kind: 'database' };
      return undefined;
    }
    case 'mongosh': case 'mongo': {
      const js = [...flagValues(argv, ['--eval']), cmd.heredoc ?? ''].join('\n');
      if (MONGO_WRITES.test(js)) return { label: `${name} changes data`, kind: 'database' };
      if (flagValues(argv, ['--file', '-f']).length || w.some((x) => x.endsWith('.js'))) return { label: `${name} runs a script`, kind: 'database' };
      return undefined;
    }
    case 'mongorestore': case 'pg_restore': case 'mysqlimport': case 'dropdb': case 'dropuser': case 'createdb':
      return name === 'createdb' ? undefined : { label: name, kind: 'database' };
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      if (['publish', 'unpublish', 'deprecate', 'dist-tag'].includes(sub) && !(sub === 'dist-tag' && ['ls', 'list'].includes(argv[2]))) return { label: `${name} ${sub}`, kind: 'publish' };
      if (sub === 'owner' && ['add', 'rm'].includes(argv[2])) return { label: `${name} owner ${argv[2]}`, kind: 'publish' };
      if (sub === 'npm' && argv[2] === 'publish') return { label: 'yarn npm publish', kind: 'publish' };
      const script = sub === 'run' || sub === 'run-script' ? w[1] : name !== 'npm' && sub && !['install', 'add', 'remove', 'i', 'ci', 'test', 'build', 'dev', 'start', 'lint', 'exec', 'dlx', 'x', 'why', 'list', 'ls', 'outdated', 'audit', 'info', 'view', 'create', 'init', 'link', 'unlink', 'update', 'upgrade', 'up'].includes(sub) ? sub : undefined;
      if (script && DEPLOY_SCRIPT.test(script)) return { label: `${name} runs the "${script}" script`, kind: 'deploy' };
      return undefined;
    }
    case 'make': case 'just': case 'task': case 'mage': case 'nx': case 'turbo': {
      const t = w.find((x) => DEPLOY_SCRIPT.test(x) && !x.includes('='));
      return t ? { label: `${name} ${t}`, kind: 'deploy' } : undefined;
    }
    case 'cargo':
      return ['publish', 'yank', 'owner'].includes(sub) ? { label: `cargo ${sub}`, kind: 'publish' } : undefined;
    case 'twine':
      return sub === 'upload' ? { label: 'twine upload', kind: 'publish' } : undefined;
    case 'gem':
      return ['push', 'yank', 'owner'].includes(sub) ? { label: `gem ${sub}`, kind: 'publish' } : undefined;
    case 'poetry': case 'uv': case 'hatch': case 'flit': case 'pdm':
      return sub === 'publish' ? { label: `${name} publish`, kind: 'publish' } : undefined;
    case 'dotnet':
      return sub === 'nuget' && ['push', 'delete'].includes(argv[2]) ? { label: `dotnet nuget ${argv[2]}`, kind: 'publish' } : undefined;
    case 'nuget':
      return ['push', 'delete'].includes(sub) ? { label: `nuget ${sub}`, kind: 'publish' } : undefined;
    case 'mvn': case 'mvnw': case './mvnw':
      return argv.some((x) => /^(deploy|release:perform|release:prepare)$/.test(x)) ? { label: 'mvn deploy', kind: 'publish' } : undefined;
    case 'gradle': case 'gradlew': case './gradlew':
      return argv.some((x) => /^(publish|publishToMavenCentral|publishAllPublicationsTo.*|publishPlugins|uploadArchives|.*[Dd]eploy.*|release)$/.test(x)) ? { label: `${name} ${argv.find((x) => /publish|[Dd]eploy|release|upload/.test(x))}`, kind: 'publish' } : undefined;
    case 'goreleaser':
      return sub === 'release' && !argv.includes('--snapshot') ? { label: 'goreleaser release', kind: 'publish' } : undefined;
    case 'fastlane': case 'bundle':
      return argv.some((x) => /^(release|deploy|beta|upload_to_app_store|deliver|pilot|supply|upload_to_play_store|appstore|production)$/.test(x)) ? { label: `fastlane ${w.find((x) => x !== 'exec' && x !== 'fastlane')}`, kind: 'publish' } : undefined;
    case 'expo': case 'eas':
      return (sub === 'submit' || sub === 'update' || (sub === 'build' && argv.includes('--auto-submit')) || sub === 'publish') ? { label: `${name} ${sub}`, kind: 'publish' } : undefined;
    case 'vsce': case 'ovsx':
      return ['publish', 'unpublish'].includes(sub) ? { label: `${name} ${sub}`, kind: 'publish' } : undefined;
    case 'chmod': case 'chown':
      return hasFlag(argv, 'R', '--recursive') && w.some((t) => t === '/' || /^\/(etc|usr|var|bin|home|Users)\/?$/.test(t)) ? { label: `${name} -R on a system folder`, kind: 'system' } : undefined;
    case 'crontab':
      return argv.includes('-r') ? { label: 'crontab -r removes every cron job', kind: 'system' } : undefined;
    case 'kill': case 'pkill': case 'killall':
      return w.includes('1') || w.includes('-1') ? { label: `${name} every process`, kind: 'system' } : undefined;
    case 'curl': case 'http': case 'https': case 'xh': case 'wget': {
      const m = flagValues(argv, ['-X', '--request', '--method']).map((x) => x.toUpperCase());
      const httpieMethod = ['http', 'https', 'xh'].includes(name) && /^(DELETE|PUT|PATCH)$/i.test(w[0] ?? '') ? w[0].toUpperCase() : undefined;
      const method = m[0] ?? httpieMethod;
      const url = w.find((x) => /^https?:\/\//.test(x) || /^[\w.-]+\.[a-z]{2,}(\/|$)/.test(x));
      if ((method === 'DELETE' || method === 'PUT' || method === 'PATCH') && url && !/^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url)) return { label: `${method} request to ${url.replace(/^https?:\/\//, '').split(/[/?#]/)[0]}`, kind: 'api' };
      return undefined;
    }
    case 'stripe':
      return w.some((x) => /^(delete|refund|refunds|cancel|payouts|transfers)$/.test(x)) && argv.includes('--live') ? { label: `stripe ${w.slice(0, 2).join(' ')} --live`, kind: 'api' } : undefined;
    default:
      return sqlRule(name, argv, cmd);
  }
}

function gitRule(argv) {
  // Skip git's own options (git -C dir push ...).
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-')) k += /^-(C|c)$|^--(git-dir|work-tree|namespace|exec-path)$/.test(argv[k]) ? 2 : 1;
  const sub = argv[k];
  const rest = argv.slice(k + 1);
  const pos = words(rest);
  switch (sub) {
    case 'push':
      if (hasFlag(rest, 'f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--prune') || pos.slice(1).some((r) => r.startsWith('+'))) return { label: 'git push --force rewrites remote history', kind: 'git' };
      if (hasFlag(rest, 'd', '--delete') || pos.slice(1).some((r) => r.startsWith(':') && r.length > 1)) return { label: 'git push deletes a remote branch or tag', kind: 'git' };
      return undefined;
    case 'reset':
      return hasFlag(rest, null, '--hard', '--merge', '--keep') ? { label: 'git reset --hard throws away local changes', kind: 'git' } : undefined;
    case 'clean':
      return hasFlag(rest, 'f', '--force') && !hasFlag(rest, 'n', '--dry-run') ? { label: 'git clean deletes untracked files', kind: 'git' } : undefined;
    case 'checkout':
      return (rest.includes('--') && (pos.includes('.') || rest[rest.indexOf('--') + 1] === '.')) || hasFlag(rest, 'f', '--force') ? { label: 'git checkout throws away local changes', kind: 'git' } : undefined;
    case 'restore':
      return !hasFlag(rest, 'S', '--staged') || hasFlag(rest, 'W', '--worktree') ? (pos.includes('.') || pos.some((p) => p.includes('*')) || hasFlag(rest, null, '--source') ? { label: 'git restore throws away local changes', kind: 'git' } : undefined) : undefined;
    case 'branch':
      return hasFlag(rest, 'D') || (hasFlag(rest, 'd', '--delete') && hasFlag(rest, 'f', '--force')) || (hasFlag(rest, 'M') ) ? { label: 'git branch -D deletes an unmerged branch', kind: 'git' } : undefined;
    case 'tag':
      return hasFlag(rest, 'd', '--delete') || hasFlag(rest, 'f', '--force') ? { label: `git tag ${hasFlag(rest, 'd', '--delete') ? '-d' : '-f'}`, kind: 'git' } : undefined;
    case 'stash':
      return ['clear', 'drop'].includes(pos[0]) ? { label: `git stash ${pos[0]}`, kind: 'git' } : undefined;
    case 'filter-branch': case 'filter-repo': case 'replace':
      return { label: `git ${sub} rewrites history`, kind: 'git' };
    case 'reflog':
      return ['expire', 'delete'].includes(pos[0]) ? { label: `git reflog ${pos[0]}`, kind: 'git' } : undefined;
    case 'update-ref':
      return hasFlag(rest, 'd') ? { label: 'git update-ref -d', kind: 'git' } : undefined;
    case 'gc':
      return rest.some((x) => x.startsWith('--prune=now')) ? { label: 'git gc --prune=now', kind: 'git' } : undefined;
    case 'rebase': case 'commit':
      return undefined;
    case 'lfs':
      return pos[0] === 'prune' ? { label: 'git lfs prune', kind: 'git' } : undefined;
    default:
      return undefined;
  }
}

function compile(list) {
  return (list ?? []).filter(Boolean).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
}

/**
 * Decides one shell command line. opts.always and opts.never are regular
 * expressions (strings or RegExp) tested against the whole line and each
 * simple command; never wins over the built-in rules, always over never.
 * Returns { gate, reasons: [{ label, kind, command, remote }], warnings }.
 */
export function classifyShell(line, opts = {}) {
  const always = compile(opts.always);
  const never = compile(opts.never);
  const reasons = [];
  const warnings = [];
  const seen = new Set();
  const visit = (text, depth, remote) => {
    if (depth > 6) {
      reasons.push({ label: 'nested too deeply to check', kind: 'unknown', command: text.slice(0, 200), remote });
      return;
    }
    let cmds;
    try {
      cmds = splitShell(text);
    } catch {
      reasons.push({ label: 'could not read the command', kind: 'unknown', command: text.slice(0, 200), remote });
      return;
    }
    for (const c of cmds) {
      const u = unwrap(c.argv);
      for (const inner of u.inner ?? []) visit(inner, depth + 1, remote || u.remote);
      if (!u.argv?.length) continue;
      const simple = u.argv.join(' ');
      if (always.some((r) => r.test(simple))) {
        reasons.push({ label: 'matches your always-ask list', kind: 'custom', command: simple, remote });
        continue;
      }
      if (never.some((r) => r.test(simple))) continue;
      const r = rule(u.argv, c);
      if (r && !seen.has(r.label + simple)) {
        seen.add(r.label + simple);
        reasons.push({ label: r.label, kind: r.kind, command: simple, remote });
        warnings.push(...(r.warnings ?? []));
      }
    }
  };
  const whole = String(line ?? '');
  if (always.some((r) => r.test(whole))) {
    reasons.push({ label: 'matches your always-ask list', kind: 'custom', command: whole.slice(0, 200) });
  } else if (never.some((r) => r.test(whole))) {
    return { gate: false, reasons: [], warnings: [] };
  }
  visit(whole, 0, false);
  return { gate: reasons.length > 0, reasons, warnings: [...new Set(warnings)] };
}
