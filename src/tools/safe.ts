import type { ToolHost } from './read.js';
import { KandoError } from '../graphql.js';

/**
 * Wrap a ToolHost so every registered handler is crash-proof: a thrown error
 * (KandoError, network failure, anything) becomes an MCP error result
 * (`isError: true`) instead of an escaped rejection that could take the process
 * — and thus the whole stdio session — down. A failed tool never kills the server.
 */
export function bulletproofHost(host: ToolHost): ToolHost {
  return {
    registerTool(name, config, cb) {
      return host.registerTool(name, config, async (args) => {
        try {
          return await cb(args);
        } catch (e) {
          const msg =
            e instanceof KandoError ? e.message : e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Kando tool error: ${msg}` }], isError: true };
        }
      });
    },
  };
}
