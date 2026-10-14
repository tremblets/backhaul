import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterEach, describe, expect, it,
} from 'vitest';
import YAML from 'yaml';

import { loadConfig, resolveFolders } from '@/config';

const tempFolders: string[] = [];

const loadConfigFrom = async (config: unknown) => {
  const folder = await mkdtemp(join(tmpdir(), 'backhaul-config-'));
  tempFolders.push(folder);
  await writeFile(join(folder, 'config.yml'), YAML.stringify(config));

  return loadConfig(folder);
};

afterEach(async () => {
  await Promise.all(tempFolders.splice(0).map(async (folder) => rm(folder, { recursive: true })));
});

const validConfig = {
  infomaniak: {
    folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
  },
  folders: [{ source: '/source/folder1', destination: '/destination/folder1' }],
};

describe('Config', () => {
  it('should load config with only required options and set defaults values', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'basic-config.yml');
    expect(config).toBeDefined();
    expect(config.schedule).toEqual('0 0 * * *');
    expect(config.runOnStart).toBe(false);
    expect(config.defaults.retention).toEqual(3);
    expect(config.infomaniak.folderUrl).toBeDefined();
    expect(config.folders).toHaveLength(1);
  });

  it('should load a full defined config file', async () => {
    const config = await loadConfig('__tests__/mocks/configs', 'full-config.yml');

    expect(config.schedule).toEqual('0 3 * * *');
    expect(config.runOnStart).toBe(true);
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

describe('Config validation', () => {
  it.each([
    [
      'an unknown root key',
      { ...validConfig, shedule: '0 0 * * *' },
      'Unrecognized key: "shedule"',
    ],
    [
      'an unknown key in a folder',
      { ...validConfig, folders: [{ ...validConfig.folders[0], retension: 10 }] },
      'folders.0: Unrecognized key: "retension"',
    ],
    [
      'an unknown key in defaults',
      { ...validConfig, defaults: { retension: 10 } },
      'defaults: Unrecognized key: "retension"',
    ],
    [
      'two folders with the same destination',
      {
        ...validConfig,
        folders: [
          { source: '/source/a', destination: '/backups/app' },
          { source: '/source/b', destination: 'backups/app/' },
        ],
      },
      'folders.1.destination: Destination "/backups/app" is already used by folders.0',
    ],
    [
      'a schedule with a seconds field',
      { ...validConfig, schedule: '0 0 0 * * *' },
      'schedule: Schedule must be a standard 5-field cron expression',
    ],
    [
      'a schedule alias',
      { ...validConfig, schedule: '@daily' },
      'schedule: Schedule must be a standard 5-field cron expression',
    ],
    [
      'an invalid cron expression',
      { ...validConfig, schedule: '0 25 * * *' },
      'schedule: Invalid cron expression',
    ],
  ])('should reject %s', async (_, config, message) => {
    await expect(loadConfigFrom(config)).rejects.toThrow(message);
  });

  it('should accept nested destinations', async () => {
    const config = await loadConfigFrom({
      ...validConfig,
      folders: [
        { source: '/source/a', destination: '/backups/app' },
        { source: '/source/b', destination: '/backups/app/db' },
      ],
    });

    expect(config.folders).toHaveLength(2);
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
