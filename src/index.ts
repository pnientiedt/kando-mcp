#!/usr/bin/env node
import { installCrashGuards } from './crashGuards.js';
import { parseCli, parseInitArgs } from './cli.js';

// First thing: never let an unexpected error take the stdio session down.
installCrashGuards();

const { cmd, args } = parseCli(process.argv.slice(2));

const USAGE = 'Usage: kando-mcp <serve|login|logout|init [dir] [--force] [--verbose]>';

try {
  if (cmd === 'serve') {
    const { serve } = await import('./serve.js');
    await serve();
  } else if (cmd === 'login') {
    const { login } = await import('./commands/login.js');
    await login();
  } else if (cmd === 'logout') {
    const { logout } = await import('./commands/logout.js');
    logout();
  } else if (cmd === 'init') {
    const { init, formatInitReport } = await import('./init.js');
    const opts = parseInitArgs(args);
    console.log(formatInitReport(init(opts.dir, { force: opts.force }), { verbose: opts.verbose }));
  } else if (cmd === 'version') {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    try {
      console.log(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'kando-mcp');
    } catch {
      console.log('kando-mcp');
    }
  } else {
    console.log(USAGE);
  }
} catch (e) {
  console.error('[kando-mcp]', e instanceof Error ? e.message : e);
  process.exit(1);
}
