// Decides which tool calls wait for approval.

import { createHash } from 'node:crypto';
import { classifySql } from './sql.js';

// Argument names that carry SQL in the database MCP servers we wrap
// (DBHub and postgres-mcp: sql; Supabase: query).
const SQL_KEYS = new Set(['sql', 'query', 'statement', 'statements', 'sql_query', 'queries', 'script']);
// Tool name prefixes that only read.
const READ_VERBS = /^(list|get|search|describe|explain|analyze|analyse|show|read|fetch|find|inspect|count|lookup|preview|generate|confirm|check|health|ping|whoami)(_|-|$)/i;

/**
 * Picks the SQL strings out of a tool call's arguments: top-level string
 * (or array of strings) values under a known SQL key.
 */
export function sqlArguments(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (!SQL_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
  }
  return out;
}

// A pattern is a tool name, a prefix ending in * or a suffix starting with *.
export function matches(list, name) {
  return list.some((p) => {
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1));
    if (p.startsWith('*')) return name.endsWith(p.slice(1));
    return p === name;
  });
}

/**
 * Decides one call. tool is the upstream tool definition (for its
 * annotations), or undefined if unknown. Returns { gate, reason, sql }
 * where sql is the classification when the call carries SQL.
 */
export function decide({ name, args, tool, mode = 'writes', allowTools = [], gateTools = [], preset }) {
  if (matches(gateTools, name)) return { gate: true, reason: 'tool is always gated' };
  if (matches(allowTools, name)) return { gate: false, reason: 'tool is always allowed' };
  if (preset && mode === 'writes') {
    if (matches(preset.gate ?? [], name)) return { gate: true, reason: `${preset.label} tool that changes something` };
    if (matches(preset.allow ?? [], name)) return { gate: false, reason: `${preset.label} tool that only reads` };
  }
  const sqls = sqlArguments(args);
  const sql = sqls.length ? classifySql(sqls.join(';\n')) : undefined;
  if (mode === 'all') return { gate: true, reason: 'every call is gated', sql };
  if (mode === 'none') return { gate: false, reason: 'gating is off', sql };
  if (sql) return { gate: sql.write, reason: sql.write ? 'SQL changes data or schema' : 'read-only SQL', sql };
  if (tool?.annotations?.readOnlyHint === true) return { gate: false, reason: 'tool is marked read-only' };
  if (READ_VERBS.test(name)) return { gate: false, reason: 'tool name reads' };
  return { gate: true, reason: 'tool may change something' };
}

/** A stable fingerprint of one call: sha256 of tool name and canonical args. */
export function fingerprint(name, args) {
  return createHash('sha256').update(JSON.stringify([name, canonical(args ?? {})])).digest('hex');
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
}
