export type Cmd = 'serve' | 'login' | 'logout' | 'init' | 'help' | 'version';

/**
 * Parse the CLI argv (excluding node + script). No subcommand → `serve` (how an
 * MCP client invokes it over stdio). Unknown subcommand → `help`.
 */
export function parseCli(argv: string[]): { cmd: Cmd; args: string[] } {
  const [first, ...rest] = argv;
  if (!first) return { cmd: 'serve', args: [] };
  if (first === '--version' || first === '-v') return { cmd: 'version', args: [] };
  if (first === '--help' || first === '-h') return { cmd: 'help', args: [] };
  if (first === 'serve' || first === 'login' || first === 'logout' || first === 'init') {
    return { cmd: first, args: rest };
  }
  return { cmd: 'help', args: [] };
}

/** `init [dir] [--force] [--verbose]` — flags in any position; dir is the first non-flag arg. */
export function parseInitArgs(args: string[]): { dir: string; force: boolean; verbose: boolean } {
  return {
    dir: args.find((a) => !a.startsWith('--')) ?? '.',
    force: args.includes('--force'),
    verbose: args.includes('--verbose'),
  };
}
