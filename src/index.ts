#!/usr/bin/env node
import { installCrashGuards } from './crashGuards.js';
import { serve } from './serve.js';

// First thing: never let an unexpected error take the stdio session down.
installCrashGuards();

// A12 expands this into a subcommand dispatcher (login/logout/serve/init);
// for now the entry point boots the server.
try {
  await serve();
} catch (e) {
  console.error('[kando-mcp]', e instanceof Error ? e.message : e);
  process.exit(1);
}
