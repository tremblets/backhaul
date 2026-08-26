import pino from 'pino';
import {
  describe, expect, it, vi,
} from 'vitest';

import { syncDestination } from '@/sync';

import type { Logger } from 'pino';

import type { BackupProvider, ProviderFile } from '@/providers/types';

const createMockLogger = (): Logger => pino({ level: 'silent' });

const createMockProvider = (overrides: Partial<BackupProvider> = {}): BackupProvider => ({
  name: 'Mock',
  resolveDestination: vi.fn().mockResolvedValue('dest-1'),
  listFiles: vi.fn().mockResolvedValue([]),
  hashFile: vi.fn().mockResolvedValue('local-hash'),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const createFile = (name: string, content = 'content'): File => new File([content], name);

describe('syncDestination', () => {
  it('should upload a file that does not exist remotely', async () => {
    const provider = createMockProvider({ listFiles: vi.fn().mockResolvedValue([]) });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(provider.uploadFile).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(result).toEqual({ uploaded: ['backup.zip'], skipped: [], failed: [] });
  });

  it('should skip a file whose remote hash matches the local hash', async () => {
    const remoteFile: ProviderFile = { id: '1', name: 'backup.zip', hash: 'same-hash' };
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([remoteFile]),
      hashFile: vi.fn().mockResolvedValue('same-hash'),
    });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(result).toEqual({ uploaded: [], skipped: ['backup.zip'], failed: [] });
  });

  it('should overwrite a file whose remote hash differs from the local hash', async () => {
    const remoteFile: ProviderFile = { id: '1', name: 'backup.zip', hash: 'old-hash' };
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([remoteFile]),
      hashFile: vi.fn().mockResolvedValue('new-hash'),
    });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(provider.uploadFile).toHaveBeenCalledTimes(1);
    expect(result.uploaded).toEqual(['backup.zip']);
  });

  it('should record a failed upload without throwing', async () => {
    const provider = createMockProvider({
      uploadFile: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([{ name: 'backup.zip', error: new Error('network error') }]);
  });

  it('should resolve and list the destination only once when nothing is uploaded', async () => {
    const remoteFile: ProviderFile = { id: '1', name: 'backup.zip', hash: 'same-hash' };
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([remoteFile]),
      hashFile: vi.fn().mockResolvedValue('same-hash'),
    });

    await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(provider.resolveDestination).toHaveBeenCalledTimes(1);
    expect(provider.listFiles).toHaveBeenCalledTimes(1);
  });

  it('should re-list the destination once more after an actual upload, for retention', async () => {
    const provider = createMockProvider({ listFiles: vi.fn().mockResolvedValue([]) });

    await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      undefined,
      [createFile('backup.zip')],
    );

    expect(provider.resolveDestination).toHaveBeenCalledTimes(2);
    expect(provider.listFiles).toHaveBeenCalledTimes(2);
  });

  it('should not list files at all when the destination does not exist yet and no upload happens', async () => {
    const provider = createMockProvider({ resolveDestination: vi.fn().mockResolvedValue(null) });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      'missing/path',
      [],
    );

    expect(provider.listFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ uploaded: [], skipped: [], failed: [] });
  });

  it('should upload a file directly when the destination does not exist yet', async () => {
    const provider = createMockProvider({
      resolveDestination: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('dest-1'),
      listFiles: vi.fn().mockResolvedValue([]),
    });

    const result = await syncDestination(
      { provider, retention: 3, logger: createMockLogger() },
      'missing/path',
      [createFile('backup.zip')],
    );

    expect(provider.uploadFile).toHaveBeenCalledWith(expect.anything(), 'missing/path');
    expect(result).toEqual({ uploaded: ['backup.zip'], skipped: [], failed: [] });
    expect(provider.resolveDestination).toHaveBeenCalledTimes(2);
  });

  it('should not call listFiles or deleteFile when retention is disabled', async () => {
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '1', name: 'a.zip' },
        { id: '2', name: 'b.zip' },
      ]),
    });

    await syncDestination(
      { provider, retention: false, logger: createMockLogger() },
      undefined,
      [],
    );

    expect(provider.listFiles).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('should delete the file with the oldest embedded timestamp when exceeding the retention limit', async () => {
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '100', name: 'jellyfin-backup-20260819103437.zip', hash: 'xxh3:old' },
        { id: '101', name: 'jellyfin-backup-20260820103437.zip', hash: 'xxh3:medium' },
        { id: '102', name: 'jellyfin-backup-20260821103437.zip', hash: 'xxh3:new' },
      ]),
    });

    await syncDestination({ provider, retention: 2, logger: createMockLogger() }, undefined, []);

    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: '100' }),
    );
  });

  it('should keep the most recently-named file even if it was uploaded to kDrive first (regression)', async () => {
    // Simulates a catch-up sync: the 08-18 backup (the oldest one) is uploaded
    // last, so its kDrive metadata order does not match name order. Retention
    // must key off the name, not upload/listing order.
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '300', name: 'jellyfin-backup-20260819103437.zip' },
        { id: '301', name: 'jellyfin-backup-20260820103437.zip' },
        { id: '302', name: 'jellyfin-backup-20260821103437.zip' },
        { id: '303', name: 'jellyfin-backup-20260818103437.zip' },
      ]),
    });

    await syncDestination({ provider, retention: 3, logger: createMockLogger() }, undefined, []);

    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: '303' }));
  });

  it('should sort by the embedded date, not the full name, for version-prefixed backup names (regression)', async () => {
    // Sonarr/Prowlarr-style names embed the app version BEFORE the date. A naive
    // full-name string comparison would sort by the version digits instead.
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '400', name: 'sonarr_backup_v4.0.9.2000_2026.08.10_22.26.05.zip' },
        { id: '401', name: 'sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip' },
        { id: '402', name: 'sonarr_backup_v4.0.20.3010_2026.08.18_22.26.05.zip' },
      ]),
    });

    await syncDestination({ provider, retention: 2, logger: createMockLogger() }, undefined, []);

    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: '400' }));
  });

  it('should handle retention deletion failures gracefully without throwing', async () => {
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '200', name: 'backup-2026-08-19.txt' },
        { id: '201', name: 'backup-2026-08-20.txt' },
      ]),
      deleteFile: vi.fn().mockRejectedValue(new Error('delete failed')),
    });

    await expect(
      syncDestination({ provider, retention: 1, logger: createMockLogger() }, undefined, []),
    ).resolves.not.toThrow();
  });

  it('should do nothing when the number of remote files is within the retention limit', async () => {
    const provider = createMockProvider({
      listFiles: vi.fn().mockResolvedValue([
        { id: '1', name: 'a.zip' },
        { id: '2', name: 'b.zip' },
      ]),
    });

    await syncDestination({ provider, retention: 3, logger: createMockLogger() }, undefined, []);

    expect(provider.deleteFile).not.toHaveBeenCalled();
  });
});
