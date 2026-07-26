import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools, type Gql } from './tools/read.js';
import { registerTicketTools } from './tools/tickets.js';
import { registerRegistryTools } from './tools/registry.js';
import { registerLoopTools } from './tools/loop.js';
import { bulletproofHost } from './tools/safe.js';

export function buildServer(gql: Gql, botEmail = ''): McpServer {
  const server = new McpServer({ name: 'kando', version: '0.1.0' });
  // Every handler is wrapped so a thrown error becomes an MCP error result
  // rather than an escaped rejection that could kill the stdio session.
  const host = bulletproofHost(server);
  registerReadTools(host, gql);
  registerTicketTools(host, gql);
  registerRegistryTools(host, gql);
  registerLoopTools(host, gql, botEmail);
  return server;
}
