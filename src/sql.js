// Tells read-only SQL from SQL that changes something. It is deliberately
// conservative: anything it does not recognise as a read counts as a write,
// so an unusual statement waits for approval instead of slipping through.

const READ_START = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'WITH', 'EXPLAIN', 'PRAGMA', 'USE']);
const TX_CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'DO']);
// Functions that change state even inside a SELECT.
const WRITE_FUNCTIONS = new Set([
  'NEXTVAL', 'SETVAL', 'SET_CONFIG', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE', 'PG_ADVISORY_LOCK', 'PG_ADVISORY_XACT_LOCK', 'LO_IMPORT', 'LO_EXPORT', 'LO_UNLINK',
  'LO_CREATE', 'LO_FROM_BYTEA', 'LO_PUT', 'DBLINK_EXEC', 'DBLINK', 'PG_FILE_WRITE', 'PG_CREATE_RESTORE_POINT',
  'PG_SWITCH_WAL', 'PG_PROMOTE', 'PG_CREATE_LOGICAL_REPLICATION_SLOT', 'PG_CREATE_PHYSICAL_REPLICATION_SLOT',
  'PG_DROP_REPLICATION_SLOT', 'SLEEP', 'BENCHMARK', 'GET_LOCK', 'LOAD_FILE', 'LOAD_EXTENSION', 'XP_CMDSHELL',
]);

/**
 * Splits sql into statements of tokens. Comments are dropped; string
 * literals and quoted identifiers become one opaque token each, so a keyword
 * inside them never counts. Throws on an unterminated quote or comment.
 */
export function tokenize(sql) {
  const statements = [];
  let tokens = [];
  const n = sql.length;
  let i = 0;
  const push = (t) => tokens.push(t);
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '#' && (i === 0 || /\s/.test(sql[i - 1]))) {
      // MySQL line comment.
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) throw new Error('unterminated comment');
    } else if (c === "'" || c === '"' || c === '`') {
      const backslash = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/\w/.test(sql[i - 2] ?? '');
      i++;
      let closed = false;
      while (i < n) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error('unterminated quote');
      push(c === "'" ? { type: 'string' } : { type: 'ident', value: '' });
    } else if (c === '[' ) {
      // SQL Server bracketed identifier.
      const end = sql.indexOf(']', i);
      if (end === -1) throw new Error('unterminated identifier');
      i = end + 1;
      push({ type: 'ident', value: '' });
    } else if (c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error('unterminated dollar quote');
        i = end + tag.length;
        push({ type: 'string' });
      } else {
        i++;
      }
    } else if (c === ';') {
      if (tokens.length) statements.push(tokens);
      tokens = [];
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      push({ type: 'word', value: sql.slice(i, j).toUpperCase() });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      push({ type: 'punct', value: c });
      i++;
    }
  }
  if (tokens.length) statements.push(tokens);
  return statements;
}

function words(tokens) {
  return tokens.filter((t) => t.type === 'word').map((t) => t.value);
}

function callsWriteFunction(tokens) {
  return tokens.some((t, k) => t.type === 'word' && WRITE_FUNCTIONS.has(t.value) && tokens[k + 1]?.value === '(');
}

function statementKind(ws) {
  const first = ws[0];
  if (['CREATE', 'DROP', 'ALTER'].includes(first)) {
    const obj = ws.slice(1).find((w) => !['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNIQUE', 'IF', 'NOT', 'EXISTS', 'GLOBAL', 'LOCAL', 'UNLOGGED', 'MATERIALIZED', 'CONCURRENTLY'].includes(w));
    return obj ? `${first} ${obj}` : first;
  }
  return first;
}

/** Classifies one statement's tokens: { kind, write, warnings }. */
function classifyStatement(tokens) {
  const ws = words(tokens);
  const first = ws[0];
  const warnings = [];
  if (!first) return { kind: 'UNKNOWN', write: true, warnings };
  if (TX_CONTROL.has(first)) return { kind: first, write: false, warnings };
  if (READ_START.has(first)) {
    let write = false;
    if (first === 'EXPLAIN') {
      // EXPLAIN ANALYZE runs the statement it explains.
      const analyze = ws.includes('ANALYZE') || ws.includes('ANALYSE');
      if (analyze) {
        const innerAt = tokens.findIndex((t) => t.type === 'word' && (WRITE_WORDS.has(t.value) || READ_START.has(t.value)) && t.value !== 'EXPLAIN');
        if (innerAt !== -1) {
          const inner = classifyStatement(tokens.slice(innerAt));
          return { kind: inner.write ? `EXPLAIN ANALYZE ${inner.kind}` : 'EXPLAIN', write: inner.write, warnings: inner.warnings };
        }
      }
      return { kind: 'EXPLAIN', write: false, warnings };
    }
    if (first === 'PRAGMA') write = tokens.some((t) => t.value === '=');
    if (first === 'WITH') {
      const inner = ws.find((w) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE'].includes(w));
      if (inner) return { kind: `WITH … ${inner}`, write: true, warnings };
    }
    if (first === 'SELECT' || first === 'WITH') {
      if (ws.includes('INTO')) return { kind: 'SELECT INTO', write: true, warnings };
    }
    if (callsWriteFunction(tokens)) return { kind: `${first} (side-effect function)`, write: true, warnings };
    return { kind: first, write, warnings };
  }
  const kind = statementKind(ws);
  if ((first === 'UPDATE' || first === 'DELETE') && !ws.includes('WHERE')) {
    warnings.push(`${first} without WHERE changes every row of the table`);
  }
  if (first === 'DROP' || first === 'TRUNCATE') warnings.push(`${kind} cannot be undone`);
  return { kind, write: true, warnings };
}

/**
 * Classifies sql. Returns { write, statements: [{ kind, write }], kinds,
 * warnings }. Unparseable SQL is a write.
 */
export function classifySql(sql) {
  let statements;
  try {
    statements = tokenize(String(sql ?? ''));
  } catch (err) {
    return { write: true, statements: [], kinds: ['UNPARSEABLE'], warnings: [`could not read the SQL (${err.message})`] };
  }
  const classified = statements.map(classifyStatement);
  const kinds = [...new Set(classified.filter((s) => s.write).map((s) => s.kind))];
  return {
    write: classified.some((s) => s.write),
    statements: classified.map(({ kind, write }) => ({ kind, write })),
    kinds,
    warnings: [...new Set(classified.flatMap((s) => s.warnings))],
  };
}
