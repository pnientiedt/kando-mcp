/**
 * Keep the MCP stdio process alive across unexpected errors.
 *
 * The JSON-RPC session lives inside this single process over one stdio pipe, so
 * a process exit silently disconnects every tool from the client with no
 * recovery. These guards log to STDERR (stdout is the MCP protocol channel) and
 * deliberately do NOT exit.
 *
 * Returns an uninstall function (used by tests to avoid leaking listeners).
 */
export function installCrashGuards(log: (...args: unknown[]) => void = console.error): () => void {
  const onUncaught = (err: unknown) => log('[kando-mcp] uncaughtException (kept alive):', err);
  const onRejection = (reason: unknown) => log('[kando-mcp] unhandledRejection (kept alive):', reason);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}
