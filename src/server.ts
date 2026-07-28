import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools, type Gql } from './tools/read.js';
import { registerTicketTools } from './tools/tickets.js';
import { registerRegistryTools } from './tools/registry.js';
import { registerCommentTools } from './tools/comments.js';
import { registerLoopTools } from './tools/loop.js';
import { bulletproofHost } from './tools/safe.js';
import { makeOnceNotice } from './sessionNotice.js';

export function buildServer(
  gql: Gql,
  opts: { email?: string; notice?: string | null } = {},
): McpServer {
  const server = new McpServer({ name: 'kando', version: '0.1.0' });
  // Every handler is wrapped so a thrown error becomes an MCP error result
  // rather than an escaped rejection that could kill the stdio session; the
  // decorator prepends the one-time expiry notice to the first successful call.
  const host = bulletproofHost(server, makeOnceNotice(opts.notice ?? null));
  registerReadTools(host, gql, opts.email ?? null);
  registerTicketTools(host, gql, opts.email ?? null);
  registerRegistryTools(host, gql);
  registerCommentTools(host, gql);
  registerLoopTools(host, gql, opts.email ?? '');
  return server;
}
