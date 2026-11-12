// A stand-in database MCP server: it records every statement it runs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ran = [];
const server = new McpServer({ name: 'fake-db', version: '1.0.0' });
server.registerTool('execute_sql', {
  description: 'Run SQL',
  inputSchema: { sql: z.string() },
}, async ({ sql }) => {
  ran.push(sql);
  return { content: [{ type: 'text', text: `ran: ${sql}` }] };
});
server.registerTool('list_tables', { description: 'List tables', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'orders, users' }] }));
server.registerTool('ran_log', { description: 'What ran', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: JSON.stringify(ran) }] }));
server.registerTool('pause_project', { description: 'Pause', inputSchema: { project_id: z.string() }, annotations: { readOnlyHint: false } }, async ({ project_id }) => {
  ran.push(`pause ${project_id}`);
  return { content: [{ type: 'text', text: 'paused' }] };
});
await server.connect(new StdioServerTransport());
