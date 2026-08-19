import { readdir, readFile, stat } from 'node:fs/promises';

import pino from 'pino';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import BackupScheduler from '@/scheduler';

import type { Logger } from 'pino';

import type { ResolvedFolder } from '@/config';
import type InfomaniakProvider from '@/providers/infomaniak.provider';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const createMockLogger = (): Logger => pino({ level: 'silent' });

const createMockUploader = () => ({
  uploadFile: vi.fn(),
});

describe('BackupScheduler', () => {
  it('should schedule a backup at 03:00', () => {
    vi.stubEnv('TZ', 'Europe/Zurich');
    const uploader = createMockUploader();
    const logger = createMockLogger();
    const entries: ResolvedFolder[] = [{ source: './folder', destination: './dest', retention: 3 }];
    const scheduler = new BackupScheduler(uploader as unknown as InfomaniakProvider, logger, entries, { schedule: '0 3 * * *' });
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

  it('should handle mixed success and error results', async () => {
    const uploader = createMockUploader();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const entries: ResolvedFolder[] = [
      { source: './folder1', destination: './dest1', retention: 3 },
      { source: './folder2', destination: './dest2', retention: 3 },
    ];

    uploader.uploadFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Upload failed'));

    // Mock file system calls - return one file per entry to get 2 uploadFile calls total
    vi.mocked(stat).mockResolvedValue(
      { isDirectory: () => true } as unknown as ReturnType<typeof stat>,
    );

    vi.mocked(readdir)
      .mockResolvedValueOnce(
        [{ name: 'file1.txt', isFile: () => true }] as unknown as ReturnType<typeof readdir>,
      )
      .mockResolvedValueOnce(
        [{ name: 'file2.txt', isFile: () => true }] as unknown as ReturnType<typeof readdir>,
      );

    vi.mocked(readFile).mockResolvedValue(Buffer.from('test content'));

    const scheduler = new BackupScheduler(uploader as unknown as InfomaniakProvider, mockLogger, entries, { schedule: '0 3 * * *' });

    // Call runBackup which should handle mixed results with Promise.allSettled
    await scheduler.runBackup();

    // Verify that uploadFile was called twice (once for each entry's single file)
    expect(uploader.uploadFile).toHaveBeenCalledTimes(2);

    // Verify that logger.info was called for at least one successful upload
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Successfully uploaded'),
    );

    // Verify that logger.error was called for the failed upload
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.any(String),
        error: expect.any(Error),
      }),
      expect.stringContaining('Error uploading'),
    );

    // Verify that runBackup completed and logged the summary
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        success: 1,
        error: 1,
      }),
      expect.stringContaining('Backup job completed'),
    );
  });
});
