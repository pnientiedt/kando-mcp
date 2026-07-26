import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadPublicConfig } from './config.js';
import { resolveAuth } from './resolveAuth.js';
import { expiryStatus, expiryMessage } from './expiry.js';
import { makeGqlClient } from './graphql.js';
import { buildServer } from './server.js';

/**
 * Boot the stdio MCP server: resolve credentials (env override → stored token →
 * error), compute the one-time expiry notice, wire the GraphQL client, and
 * connect. A near-expiry session also warns on stderr for good measure.
 */
export async function serve(): Promise<void> {
  const config = loadPublicConfig();
  const { provider, email, savedAt } = resolveAuth(config);
  const status = expiryStatus(savedAt);
  const notice = status?.warn ? expiryMessage(status.daysLeft) : null;
  if (notice) console.error(`[kando-mcp] ${notice}`);
  const gql = makeGqlClient(config, provider);
  const server = buildServer(gql, { email, notice });
  await server.connect(new StdioServerTransport());
}
