import { readdir, readFile, stat } from 'node:fs/promises';

import pino from 'pino';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import BackupScheduler from '@/scheduler';

import { syncDestination } from '../src/sync';

import type { Logger } from 'pino';

import type { ResolvedFolder } from '@/config';
import type { BackupProvider } from '@/providers/types';
import type { SyncResult } from '@/sync';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// NOTE: mocked by relative path, not the '@/sync' alias — vi.mock does not
// intercept aliased specifiers reliably with this project's vitest config.
vi.mock('../src/sync', () => ({
  syncDestination: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const createMockLogger = (): Logger => pino({ level: 'silent' });

const createMockProvider = (): BackupProvider => ({
  name: 'KDrive',
  resolveDestination: vi.fn(),
  listFiles: vi.fn(),
  hashFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
});

const emptyResult: SyncResult = { uploaded: [], skipped: [], failed: [] };

describe('BackupScheduler', () => {
  it('should schedule a backup at 03:00', () => {
    vi.stubEnv('TZ', 'Europe/Zurich');
    const provider = createMockProvider();
    const logger = createMockLogger();
    const entries: ResolvedFolder[] = [{ source: './folder', destination: './dest', retention: 3 }];
    const scheduler = new BackupScheduler(provider, logger, entries, { schedule: '0 3 * * *' });
    scheduler.init();
    const nextRun = scheduler.nextRun();
    expect(nextRun).not.toBeNull();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(nextRun as string));
    expect(parts).toBe('03:00');
    scheduler.stop();
  });

  it('should sync once per destination and aggregate the results', async () => {
    const provider = createMockProvider();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    const entries: ResolvedFolder[] = [
      { source: './folder1', destination: './dest1', retention: 3 },
      { source: './folder2', destination: './dest2', retention: 3 },
    ];

    vi.mocked(syncDestination)
      .mockResolvedValueOnce({ uploaded: ['file1.txt'], skipped: [], failed: [] })
      .mockResolvedValueOnce({ uploaded: [], skipped: [], failed: [{ name: 'file2.txt', error: new Error('Upload failed') }] });

    vi.mocked(stat).mockResolvedValue(
      { isDirectory: () => true } as unknown as Awaited<ReturnType<typeof stat>>,
    );

    vi.mocked(readdir)
      .mockResolvedValueOnce(
        [{ name: 'file1.txt', isFile: () => true }] as unknown as Awaited<ReturnType<typeof readdir>>,
      )
      .mockResolvedValueOnce(
        [{ name: 'file2.txt', isFile: () => true }] as unknown as Awaited<ReturnType<typeof readdir>>,
      );

    vi.mocked(readFile).mockResolvedValue(Buffer.from('test content'));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(2);
    expect(syncDestination).toHaveBeenCalledWith(
      provider,
      './dest1',
      expect.arrayContaining([expect.objectContaining({ name: 'file1.txt' })]),
      3,
      mockLogger,
    );
    expect(syncDestination).toHaveBeenCalledWith(
      provider,
      './dest2',
      expect.arrayContaining([expect.objectContaining({ name: 'file2.txt' })]),
      3,
      mockLogger,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      { uploaded: 1, skipped: 0, failed: 1 },
      'Backup job completed.',
    );
  });

  it('should not upload files that fall outside the local retention window', async () => {
    const provider = createMockProvider();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    const entries: ResolvedFolder[] = [
      { source: './folder', destination: './dest', retention: 3 },
    ];

    vi.mocked(syncDestination).mockResolvedValue(emptyResult);
    vi.mocked(stat).mockResolvedValue(
      { isDirectory: () => true } as unknown as Awaited<ReturnType<typeof stat>>,
    );
    vi.mocked(readdir).mockResolvedValue(
      [
        { name: 'jellyfin-backup-20260818000000.zip', isFile: () => true },
        { name: 'jellyfin-backup-20260819000000.zip', isFile: () => true },
        { name: 'jellyfin-backup-20260820000000.zip', isFile: () => true },
        { name: 'jellyfin-backup-20260821000000.zip', isFile: () => true },
      ] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    vi.mocked(readFile).mockResolvedValue(Buffer.from('test content'));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(1);
    const [, , files] = vi.mocked(syncDestination).mock.calls[0];
    expect((files).map((file) => file.name).sort()).toEqual([
      'jellyfin-backup-20260819000000.zip',
      'jellyfin-backup-20260820000000.zip',
      'jellyfin-backup-20260821000000.zip',
    ]);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: './dest',
        prunedCount: 1,
        files: ['jellyfin-backup-20260818000000.zip'],
      }),
      expect.stringContaining('Skipping upload'),
    );
  });

  it('should upload every file when retention is disabled', async () => {
    const provider = createMockProvider();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    const entries: ResolvedFolder[] = [
      { source: './folder', destination: './dest', retention: false },
    ];

    vi.mocked(syncDestination).mockResolvedValue(emptyResult);
    vi.mocked(stat).mockResolvedValue(
      { isDirectory: () => true } as unknown as Awaited<ReturnType<typeof stat>>,
    );
    vi.mocked(readdir).mockResolvedValue(
      [
        { name: 'a.zip', isFile: () => true },
        { name: 'b.zip', isFile: () => true },
      ] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    vi.mocked(readFile).mockResolvedValue(Buffer.from('test content'));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    await scheduler.runBackup();

    const [, , files] = vi.mocked(syncDestination).mock.calls[0];
    expect((files).map((file) => file.name).sort()).toEqual(['a.zip', 'b.zip']);
  });
});
