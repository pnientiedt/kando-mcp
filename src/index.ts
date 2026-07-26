#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installCrashGuards } from './crashGuards.js';
import { loadRuntime } from './startup.js';
import { srpTokenProvider } from './auth.js';
import { makeGqlClient } from './graphql.js';
import { buildServer } from './server.js';

// First thing: never let an unexpected error take the stdio session down.
installCrashGuards();

const here = dirname(fileURLToPath(import.meta.url));

// Credentials live at <target>/.kando/.env; fall back to the legacy `credentials`
// filename so an install that predates the rename keeps working until it re-runs.
const kandoDir = join(here, '..');
const envPath = existsSync(join(kandoDir, '.env'))
  ? join(kandoDir, '.env')
  : join(kandoDir, 'credentials');

let runtime;
try {
  runtime = loadRuntime(envPath);
} catch (e) {
  console.error(
    '[kando-mcp] failed to start — could not load config/credentials:',
    e instanceof Error ? e.message : e,
  );
  console.error(
    '[kando-mcp] check that <repo>/.kando/.env exists with KANDO_BOT_EMAIL and KANDO_BOT_PASSWORD.',
  );
  process.exit(1);
}

const gql = makeGqlClient(runtime.config, srpTokenProvider(runtime.config, runtime.creds));
const server = buildServer(gql, runtime.creds.email);

try {
  await server.connect(new StdioServerTransport());
} catch (e) {
  console.error('[kando-mcp] failed to connect stdio transport:', e instanceof Error ? e.message : e);
  process.exit(1);
}
