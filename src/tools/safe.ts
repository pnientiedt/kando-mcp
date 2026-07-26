import type { ToolHost } from './read.js';
import { KandoError } from '../graphql.js';

/**
 * Wrap a ToolHost so every registered handler is crash-proof: a thrown error
 * (KandoError, network failure, anything) becomes an MCP error result
 * (`isError: true`) instead of an escaped rejection that could take the process
 * — and thus the whole stdio session — down. A failed tool never kills the server.
 *
 * `decorate` post-processes each SUCCESSFUL result (the error path is left
 * untouched). It carries the one-time session-expiry notice; default is identity.
 */
export function bulletproofHost(host: ToolHost, decorate: (r: any) => any = (r) => r): ToolHost {
  return {
    registerTool(name, config, cb) {
      return host.registerTool(name, config, async (args) => {
        try {
          return decorate(await cb(args));
        } catch (e) {
          const msg =
            e instanceof KandoError ? e.message : e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Kando tool error: ${msg}` }], isError: true };
        }
      });
    },
  };
}
