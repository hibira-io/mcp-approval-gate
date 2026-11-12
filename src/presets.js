// Presets for well-known MCP servers that are not databases: which tools only
// read (so they never wait), which always wait, and a plain title for the
// approval page. Anything a preset does not name falls back to the usual
// rules (readOnlyHint, read-like names, otherwise it waits).

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const first = (args, ...keys) => {
  for (const k of keys) {
    const v = args?.[k];
    if (Array.isArray(v) && v.length) return v.map(String).join(', ');
    if (str(v)) return str(v);
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};
const repo = (a) => (a?.owner && a?.repo ? `${a.owner}/${a.repo}` : first(a, 'repository', 'repo'));
const words = (name) => name.replace(/[_-]+/g, ' ');

export const PRESETS = {
  // Stripe's hosted server (https://mcp.stripe.com): one generic write tool
  // plus Treasury money movement.
  stripe: {
    label: 'Stripe',
    allow: ['stripe_api_read', 'stripe_api_search', 'stripe_api_details', 'search_stripe_documentation',
      'stripe_analytics', 'stripe_implementation_planner', 'get_*'],
    gate: ['stripe_api_write', 'send_money', 'transfer_money', 'convert_currency', 'setup_recipient', 'atlas_company_formation'],
    title(name, a) {
      if (name === 'stripe_api_write') {
        const what = first(a, 'method', 'operation', 'api_method', 'name');
        const path = first(a, 'path', 'endpoint', 'url', 'resource');
        return `Stripe: ${[what, path].filter(Boolean).join(' ') || 'write'}`;
      }
      const amount = first(a, 'amount');
      const currency = first(a, 'currency');
      return `Stripe: ${words(name)}${amount ? ` ${amount}${currency ? ` ${currency.toUpperCase()}` : ''}` : ''}`;
    },
  },
  // GitHub's MCP server (github/github-mcp-server).
  github: {
    label: 'GitHub',
    allow: ['get_*', 'list_*', 'search_*', '*_read', 'actions_get', 'actions_list'],
    gate: ['merge_pull_request', 'delete_file', 'push_files', 'create_or_update_file', 'create_repository',
      'fork_repository', 'actions_run_trigger', 'update_pull_request_branch', 'enable_pr_auto_merge'],
    title(name, a) {
      const r = repo(a);
      const n = first(a, 'pullNumber', 'pull_number', 'issue_number', 'issueNumber');
      const ref = first(a, 'branch', 'path', 'name');
      return `GitHub: ${words(name)}${r ? ` ${r}` : ''}${n ? `#${n}` : ''}${!n && ref ? ` (${ref})` : ''}`;
    },
  },
  // Google's Gmail MCP server: drafts are fine, anything that sends, deletes
  // or changes filters waits.
  gmail: {
    label: 'Gmail',
    allow: ['get_*', 'list_*', 'search_*', 'create_draft', 'update_draft'],
    gate: ['send_message', 'send_draft', 'reply', 'forward', 'delete_*', 'trash_*', 'create_filter', 'update_label', 'delete_label'],
    title(name, a) {
      const to = first(a, 'to', 'recipients', 'recipient');
      const subject = first(a, 'subject');
      if (['send_message', 'send_draft', 'reply', 'forward'].includes(name)) {
        return `Gmail: ${words(name)}${to ? ` to ${to}` : ''}${subject ? `: ${subject}` : ''}`;
      }
      return `Gmail: ${words(name)}`;
    },
  },
  // Shopify store tools (product, discount, inventory and GraphQL Admin).
  shopify: {
    label: 'Shopify',
    allow: ['get-*', 'get_*', 'list-*', 'search*', 'find-*', 'graphql_query', 'graphql_schema', 'run-analytics-query',
      'validate_graphql_codeblocks', 'search_docs_chunks'],
    gate: ['graphql_mutation', 'create-*', 'update-*', 'bulk-*', 'set-*', 'add-to-*', 'delete-*', 'publish-*', 'upload*', 'import-*'],
    title(name, a) {
      const what = first(a, 'title', 'name', 'code', 'productId', 'id');
      return `Shopify: ${words(name)}${what ? ` (${what})` : ''}`;
    },
  },
};

/** The preset called name, or throws listing the ones there are. */
export function preset(name) {
  if (!name) return undefined;
  const p = PRESETS[name.toLowerCase()];
  if (!p) throw new Error(`unknown --preset "${name}"; one of ${Object.keys(PRESETS).join(', ')}`);
  return p;
}
