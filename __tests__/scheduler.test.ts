import { openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';

import pino from 'pino';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import BackupScheduler, { isSuccessful } from '@/scheduler';

import { syncDestination } from '../src/sync';

import type { Logger } from 'pino';

import type { ResolvedFolder } from '@/config';
import type { BackupProvider } from '@/providers/types';
import type { BackupRunResult } from '@/scheduler';
import type { SyncResult } from '@/sync';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<object>(),
  openAsBlob: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
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

const emptyRunResult: BackupRunResult = { ...emptyResult, failedFolders: [] };

const createRecordingLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
}) as unknown as Logger;

const folderStat = { isDirectory: () => true } as unknown as Awaited<ReturnType<typeof stat>>;

const asDirents = (names: string[]) => names.map(
  (name) => ({ name, isFile: () => true }),
) as unknown as Awaited<ReturnType<typeof readdir>>;

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

  it('should run a backup on init when runOnStart is enabled', async () => {
    const scheduler = new BackupScheduler(
      createMockProvider(),
      createMockLogger(),
      [],
      { schedule: '0 3 * * *', runOnStart: true },
    );
    const runBackup = vi.spyOn(scheduler, 'runBackup').mockResolvedValue(emptyRunResult);

    scheduler.init();

    await vi.waitFor(() => expect(runBackup).toHaveBeenCalledTimes(1));
    scheduler.stop();
  });

  it('should not run a backup on init by default', () => {
    const scheduler = new BackupScheduler(
      createMockProvider(),
      createMockLogger(),
      [],
      { schedule: '0 3 * * *' },
    );
    const runBackup = vi.spyOn(scheduler, 'runBackup').mockResolvedValue(emptyRunResult);

    scheduler.init();

    expect(runBackup).not.toHaveBeenCalled();
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

    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    const result = await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(2);
    expect(syncDestination).toHaveBeenCalledWith(
      { provider, retention: 3, logger: mockLogger },
      './dest1',
      expect.arrayContaining([expect.objectContaining({ name: 'file1.txt' })]),
    );
    expect(syncDestination).toHaveBeenCalledWith(
      { provider, retention: 3, logger: mockLogger },
      './dest2',
      expect.arrayContaining([expect.objectContaining({ name: 'file2.txt' })]),
    );

    expect(result.uploaded).toEqual(['file1.txt']);
    expect(result.failed).toEqual([{ name: 'file2.txt', error: expect.any(Error) }]);
    expect(isSuccessful(result)).toBe(false);

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        uploaded: 1, skipped: 0, failed: 1, failedFolders: 0,
      },
      'Backup job completed with errors.',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      { nextRunTime: scheduler.nextRun() },
      'Next run',
    );
  });

  it('should log a successful run at info level', async () => {
    const mockLogger = createRecordingLogger();

    vi.mocked(syncDestination).mockResolvedValue({ uploaded: ['file1.txt'], skipped: [], failed: [] });
    vi.mocked(stat).mockResolvedValue(folderStat);
    vi.mocked(readdir).mockResolvedValue(asDirents(['file1.txt']));
    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(
      createMockProvider(),
      mockLogger,
      [{ source: './folder1', destination: './dest1', retention: 3 }],
      { schedule: '0 3 * * *' },
    );

    const result = await scheduler.runBackup();

    expect(isSuccessful(result)).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        uploaded: 1, skipped: 0, failed: 0, failedFolders: 0,
      },
      'Backup job completed.',
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should keep syncing the next destination when one destination fails', async () => {
    const mockLogger = createRecordingLogger();
    const syncError = new Error('kDrive unreachable');

    vi.mocked(syncDestination)
      .mockRejectedValueOnce(syncError)
      .mockResolvedValueOnce({ uploaded: ['file2.txt'], skipped: [], failed: [] });
    vi.mocked(stat).mockResolvedValue(folderStat);
    vi.mocked(readdir)
      .mockResolvedValueOnce(asDirents(['file1.txt']))
      .mockResolvedValueOnce(asDirents(['file2.txt']));
    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(
      createMockProvider(),
      mockLogger,
      [
        { source: './folder1', destination: './dest1', retention: 3 },
        { source: './folder2', destination: './dest2', retention: 3 },
      ],
      { schedule: '0 3 * * *' },
    );

    const result = await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(2);
    expect(result.uploaded).toEqual(['file2.txt']);
    expect(result.failedFolders).toEqual([{ folder: './dest1', error: syncError }]);
    expect(isSuccessful(result)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      { destination: './dest1', error: syncError },
      'Could not sync destination',
    );
  });

  it.each([
    [
      'missing',
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      'Source folder does not exist',
    ],
    [
      'unreadable',
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      'Could not read source folder',
    ],
  ])('should report a %s source folder as a failure and back up the others', async (_, statError, message) => {
    const mockLogger = createRecordingLogger();

    vi.mocked(syncDestination).mockResolvedValue({ uploaded: ['file2.txt'], skipped: [], failed: [] });
    vi.mocked(stat)
      .mockRejectedValueOnce(statError)
      .mockResolvedValueOnce(folderStat);
    vi.mocked(readdir).mockResolvedValue(asDirents(['file2.txt']));
    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(
      createMockProvider(),
      mockLogger,
      [
        { source: './folder1', destination: './dest1', retention: 3 },
        { source: './folder2', destination: './dest2', retention: 3 },
      ],
      { schedule: '0 3 * * *' },
    );

    const result = await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(1);
    expect(syncDestination).toHaveBeenCalledWith(expect.anything(), './dest2', expect.anything());
    expect(result.failedFolders).toEqual([
      { folder: expect.stringContaining('folder1'), error: statError },
    ]);
    expect(isSuccessful(result)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      { folder: expect.stringContaining('folder1'), error: statError },
      message,
    );
  });

  it('should report a source path that is not a folder as a failure', async () => {
    vi.mocked(stat).mockResolvedValue(
      { isDirectory: () => false } as unknown as Awaited<ReturnType<typeof stat>>,
    );

    const scheduler = new BackupScheduler(
      createMockProvider(),
      createRecordingLogger(),
      [{ source: './file.zip', destination: './dest', retention: 3 }],
      { schedule: '0 3 * * *' },
    );

    const result = await scheduler.runBackup();

    expect(syncDestination).not.toHaveBeenCalled();
    expect(result.failedFolders).toHaveLength(1);
    expect(isSuccessful(result)).toBe(false);
  });

  it('should only warn about an empty source folder', async () => {
    const mockLogger = createRecordingLogger();

    vi.mocked(stat).mockResolvedValue(folderStat);
    vi.mocked(readdir).mockResolvedValue(asDirents([]));

    const scheduler = new BackupScheduler(
      createMockProvider(),
      mockLogger,
      [{ source: './folder', destination: './dest', retention: 3 }],
      { schedule: '0 3 * * *' },
    );

    const result = await scheduler.runBackup();

    expect(syncDestination).not.toHaveBeenCalled();
    expect(isSuccessful(result)).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { folder: expect.stringContaining('folder') },
      'Source folder is empty',
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
    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    await scheduler.runBackup();

    expect(syncDestination).toHaveBeenCalledTimes(1);
    const [, , files] = vi.mocked(syncDestination).mock.calls[0];
    expect((files).map((file) => file.name).sort()).toEqual([
      'jellyfin-backup-20260819000000.zip',
      'jellyfin-backup-20260820000000.zip',
      'jellyfin-backup-20260821000000.zip',
    ]);

    expect(mockLogger.debug).toHaveBeenCalledWith(
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
    vi.mocked(openAsBlob).mockResolvedValue(new Blob(['test content']));

    const scheduler = new BackupScheduler(provider, mockLogger, entries, { schedule: '0 3 * * *' });

    await scheduler.runBackup();

    const [, , files] = vi.mocked(syncDestination).mock.calls[0];
    expect((files).map((file) => file.name).sort()).toEqual(['a.zip', 'b.zip']);
  });
});
