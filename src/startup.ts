import { loadPublicConfig, loadCredentials, type PublicConfig } from './config.js';

export type Runtime = {
  config: PublicConfig;
  creds: { email: string; password: string };
};

/**
 * Load everything the server needs to run. Throws a readable error (naming the
 * missing piece and the credentials path) so a bad `.kando/credentials` is
 * diagnosable on startup rather than a silent process exit.
 */
export function loadRuntime(credsPath: string): Runtime {
  const config = loadPublicConfig();
  const creds = loadCredentials(credsPath);
  return { config, creds };
}
