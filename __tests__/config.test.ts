import { describe, expect, it } from 'vitest';

import { loadConfig, resolveFolders } from '@/config';

describe('Config', () => {
  it('should load config with only required options and set defaults values', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'basic-config.yml');
    expect(config).toBeDefined();
    expect(config.schedule).toEqual('0 0 * * *');
    expect(config.defaults.retention).toEqual(3);
    expect(config.infomaniak.folderUrl).toBeDefined();
    expect(config.folders).toHaveLength(1);
  });

  it('should load a full defined config file', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'full-config.yml');

    expect(config.schedule).toEqual('0 3 * * *');
    expect(config.defaults.retention).toEqual(5);
    expect(config.infomaniak.folderUrl).toEqual('https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890');
    expect(config.folders).toHaveLength(2);
    expect(config.folders[0].retention).toBeUndefined();
    expect(config.folders[1].retention).toEqual(3);
  });

  it('should throw an error for missing config file', async () => {
    await expect(loadConfig('./nonexistent-folder')).rejects.toThrow('Failed to load config');
  });

  it('should validate infomaniak URL', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'basic-config.yml');
    expect(config).toMatchObject({
      infomaniak: {
        folderUrl: expect.stringContaining('ksuite.infomaniak.com'),
      },
    });
  });
});

describe('resolveFolders', () => {
  it('applies the default retention to entries without an explicit one', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'full-config.yml');
    const resolved = resolveFolders(config);

    expect(resolved[0].retention).toEqual(config.defaults.retention);
  });

  it("preserves an entry's explicit retention over the default", async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'full-config.yml');
    const resolved = resolveFolders(config);

    expect(resolved[1].retention).toEqual(3);
  });
});
