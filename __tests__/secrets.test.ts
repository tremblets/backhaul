import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { loadSecrets } from '@/secrets';

vi.mock('node:fs', () => ({
  existsSync: () => false,
}));

describe('Secrets', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load secrets from environment variable', async () => {
    process.env.INFOMANIAK_API_KEY = 'test-api-key';
    const secrets = await loadSecrets();
    expect(secrets.INFOMANIAK_API_KEY).toBe('test-api-key');
  });

  it('should throw error when secret is missing', async () => {
    delete process.env.INFOMANIAK_API_KEY;
    await expect(loadSecrets()).rejects.toThrow('Secret \'infomaniak_api_key\' not found');
  });

  it('should trim whitespace from secrets', async () => {
    process.env.INFOMANIAK_API_KEY = '  test-api-key  ';
    const secrets = await loadSecrets();
    expect(secrets.INFOMANIAK_API_KEY).toBe('test-api-key');
  });
});
