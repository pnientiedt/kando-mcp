import { describe, it, expect } from 'vitest';
import { loadPublicConfig } from './config.js';

describe('config', () => {
  it('loads the committed public config', () => {
    const c = loadPublicConfig();
    expect(c.userPoolId).toBe('eu-central-1_djhXXORIL');
    expect(c.graphqlUrl).toContain('appsync-api');
  });
});
