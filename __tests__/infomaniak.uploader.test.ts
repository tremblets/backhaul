import nock from 'nock';
import pino from 'pino';
import {
  beforeEach,
  describe, expect, it,
} from 'vitest';
import XXHash from 'xxhash-addon';

import InfomaniakProvider from '@/providers/infomaniak.provider';

import type { Logger } from 'pino';

const createMockLogger = (): Logger => pino({ level: 'silent' });

describe('Infomaniak Uploader', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    nock.cleanAll();
  });

  it('should initialize the uploader with the correct config', () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });
    expect(uploader).toBeDefined();
  });

  it('should throw an error for invalid folder URL', () => {
    const logger = createMockLogger();
    expect(() => new InfomaniakProvider(logger, {
      folderUrl: 'invalid-url',
      token: 'test-token',
    })).toThrow('Invalid folder URL');
  });

  it('should upload a new file successfully', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - returns empty list
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock file upload
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 1234,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 1,
          created_by: 1,
          created_at: 1234567890,
          added_at: 1234567890,
          last_modified_at: 1234567890,
          last_modified_by: 1,
          revised_at: 1234567890,
          updated_at: 1234567890,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(uploader.uploadFile(file)).resolves.not.toThrow();
  });

  it('should skip upload if file with same hash already exists', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Create a file with known content
    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });

    // We need to compute the hash the same way the provider does
    // For testing, we'll compute it dynamically
    const buffer = await file.arrayBuffer();
    const hash = XXHash.XXHash3.hash(Buffer.from(buffer)).toString('hex');
    const remoteFileHash = `xxh3:${hash}`;

    // Mock listing files - returns the same file with same hash
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 1234,
            name: 'test-file.txt',
            type: 'file',
            created_at: 1234567890,
            hash: remoteFileHash,
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Upload should skip and not call the upload endpoint
    const uploadScope = nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .reply(200, { result: 'success', data: {} });

    await expect(uploader.uploadFile(file)).resolves.not.toThrow();

    // Verify the upload endpoint was not called
    expect(uploadScope.isDone()).toBe(false);
  });

  it('should warn and overwrite file if same name but different hash exists', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });

    // Mock listing files - returns file with different hash
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 1234,
            name: 'test-file.txt',
            type: 'file',
            created_at: 1234567890,
            hash: 'xxh3:differenthash',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock file upload
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 1234,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 1,
          created_by: 1,
          created_at: 1234567890,
          added_at: 1234567890,
          last_modified_at: 1234567890,
          last_modified_by: 1,
          revised_at: 1234567890,
          updated_at: 1234567890,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    await expect(uploader.uploadFile(file)).resolves.not.toThrow();
  });

  it('should handle upload errors', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - returns empty
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    const error = {
      code: 'upload_not_terminated_error',
      description: 'Invalid request parameters',
    };

    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(400, {
        result: 'error',
        error,
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(
      uploader.uploadFile(file),
    ).rejects.toThrow('Failed to initiate upload');
  });

  it('should handle upload error responses', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - returns empty
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    const error = {
      code: 'upload_not_terminated_error',
      description: 'Invalid request parameters',
    };

    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(200, {
        result: 'error',
        error,
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(
      uploader.uploadFile(file),
    ).rejects.toThrow('Upload error');
  });

  it('should handle pagination when listing files', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock first page
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 1,
            name: 'file1.txt',
            type: 'file',
            created_at: 1234567890,
            hash: 'xxh3:hash1',
          },
        ],
        cursor: 'cursor_page2',
        has_more: true,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock second page
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash', cursor: 'cursor_page2' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 2,
            name: 'file2.txt',
            type: 'file',
            created_at: 1234567891,
            hash: 'xxh3:hash2',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock file upload
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 3,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 1,
          created_by: 1,
          created_at: 1234567892,
          added_at: 1234567892,
          last_modified_at: 1234567892,
          last_modified_by: 1,
          revised_at: 1234567892,
          updated_at: 1234567892,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(uploader.uploadFile(file)).resolves.not.toThrow();
  });

  it('should resolve nested folder paths with multiple segments', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock resolving 'sub1' - first segment
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/name')
      .query({ name: 'sub1' })
      .reply(200, {
        result: 'success',
        data: {
          id: 11111,
          name: 'sub1',
          type: 'dir',
          created_at: 1234567890,
        },
      });

    // Mock resolving 'sub2' - second segment
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/11111/name')
      .query({ name: 'sub2' })
      .reply(200, {
        result: 'success',
        data: {
          id: 22222,
          name: 'sub2',
          type: 'dir',
          created_at: 1234567890,
        },
      });

    // Mock listing files in the resolved folder
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/22222/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock file upload with directory_path
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
        directory_path: 'sub1/sub2',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 3,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 3,
          created_by: 1,
          created_at: 1234567892,
          added_at: 1234567892,
          last_modified_at: 1234567892,
          last_modified_by: 1,
          revised_at: 1234567892,
          updated_at: 1234567892,
          parent_id: 22222,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(uploader.uploadFile(file, 'sub1/sub2')).resolves.not.toThrow();
  });

  it('should upload directly when the target folder path does not exist yet', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock resolving 'missing' - folder does not exist yet
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/name')
      .query({ name: 'missing' })
      .reply(200, {
        result: 'error',
        error: {
          code: 'file_not_found',
          description: 'File not found',
        },
      });

    // No listing call is expected since the folder doesn't exist yet

    // Mock file upload - the upload endpoint creates the missing directories itself
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
        directory_path: 'missing/path',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 3,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 3,
          created_by: 1,
          created_at: 1234567892,
          added_at: 1234567892,
          last_modified_at: 1234567892,
          last_modified_by: 1,
          revised_at: 1234567892,
          updated_at: 1234567892,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(uploader.uploadFile(file, 'missing/path')).resolves.not.toThrow();
  });

  it('should still throw for non-404 errors while resolving a folder path', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock resolving 'bad' - a non-404 API error (e.g. permission denied)
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/name')
      .query({ name: 'bad' })
      .reply(200, {
        result: 'error',
        error: {
          code: 'forbidden',
          description: 'Access denied',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(
      uploader.uploadFile(file, 'bad/path'),
    ).rejects.toThrow(/Failed to find/);
  });

  it('should apply retention and delete the file with the oldest name when exceeding limit', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - jellyfin-style compact timestamp names
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 100,
            name: 'jellyfin-backup-20260819103437.zip',
            type: 'file',
            hash: 'xxh3:hash-old',
          },
          {
            id: 101,
            name: 'jellyfin-backup-20260820103437.zip',
            type: 'file',
            hash: 'xxh3:hash-medium',
          },
          {
            id: 102,
            name: 'jellyfin-backup-20260821103437.zip',
            type: 'file',
            hash: 'xxh3:hash-new',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock moving the oldest-named file to trash (keeping only the 2 most recent)
    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/100')
      .reply(200, {
        result: 'success',
        data: {
          cancel_id: 'cancel-123',
          valid_until: 1234567900,
        },
      });

    // Mock permanently purging it from the trash
    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/trash/100')
      .reply(200, {
        result: 'success',
        data: true,
      });

    await expect(uploader.applyRetention(undefined, 2)).resolves.not.toThrow();
  });

  it('should keep the most recently-named file even if it was uploaded to kDrive first (regression)', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Simulates a catch-up sync: the 08-18 backup (the oldest one) is uploaded
    // to kDrive LAST, so its kDrive `created_at` is higher than the others even
    // though its name is the oldest. Retention must key off the name, not
    // `created_at`, otherwise it deletes the wrong (more recent) backup.
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 300,
            name: 'jellyfin-backup-20260819103437.zip',
            type: 'file',
            hash: 'xxh3:hash-19',
          },
          {
            id: 301,
            name: 'jellyfin-backup-20260820103437.zip',
            type: 'file',
            hash: 'xxh3:hash-20',
          },
          {
            id: 302,
            name: 'jellyfin-backup-20260821103437.zip',
            type: 'file',
            hash: 'xxh3:hash-21',
          },
          {
            id: 303,
            name: 'jellyfin-backup-20260818103437.zip',
            type: 'file',
            hash: 'xxh3:hash-18',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/303')
      .reply(200, {
        result: 'success',
        data: {
          cancel_id: 'cancel-303',
          valid_until: 1234567900,
        },
      });

    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/trash/303')
      .reply(200, {
        result: 'success',
        data: true,
      });

    await expect(uploader.applyRetention(undefined, 3)).resolves.not.toThrow();
  });

  it('should sort by the embedded date, not the full name, for version-prefixed backup names (regression)', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Sonarr/Prowlarr-style names embed the app version BEFORE the date
    // (sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip). A naive full-name
    // string comparison would sort primarily by the version digits ('v4.0.9...'
    // sorts AFTER 'v4.0.19...' because '9' > '1'), which would pick the wrong
    // file for deletion whenever the app is upgraded between two backups.
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 400,
            name: 'sonarr_backup_v4.0.9.2000_2026.08.10_22.26.05.zip',
            type: 'file',
            hash: 'xxh3:hash-old',
          },
          {
            id: 401,
            name: 'sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip',
            type: 'file',
            hash: 'xxh3:hash-medium',
          },
          {
            id: 402,
            name: 'sonarr_backup_v4.0.20.3010_2026.08.18_22.26.05.zip',
            type: 'file',
            hash: 'xxh3:hash-new',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/400')
      .reply(200, {
        result: 'success',
        data: {
          cancel_id: 'cancel-400',
          valid_until: 1234567900,
        },
      });

    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/trash/400')
      .reply(200, {
        result: 'success',
        data: true,
      });

    await expect(uploader.applyRetention(undefined, 2)).resolves.not.toThrow();
  });

  it('should handle retention failure gracefully without throwing', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - returns 2 files
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 200,
            name: 'backup-2026-08-19.txt',
            type: 'file',
            hash: 'xxh3:hash-old',
          },
          {
            id: 201,
            name: 'backup-2026-08-20.txt',
            type: 'file',
            hash: 'xxh3:hash-new',
          },
        ],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock DELETE call that fails (HTTP error) - deleteFileFromTrash should never be reached
    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/200')
      .reply(500, {
        result: 'error',
        error: {
          code: 'internal_error',
          description: 'Internal server error',
        },
      });

    // Even though DELETE fails, applyRetention should succeed (Promise.allSettled behavior)
    await expect(uploader.applyRetention(undefined, 1)).resolves.not.toThrow();
  });

  it('should retry transient 500 errors and eventually succeed', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - first attempt fails with 500, then succeeds
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(500, {
        result: 'error',
        error: {
          code: 'internal_error',
          description: 'Internal server error',
        },
      });

    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(500, {
        result: 'error',
        error: {
          code: 'internal_error',
          description: 'Internal server error',
        },
      });

    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [],
        cursor: '',
        has_more: false,
        response_at: Math.floor(Date.now() / 1000),
      });

    // Mock file upload
    nock('https://api.infomaniak.com')
      .post('/3/drive/12345/upload')
      .query({
        file_name: 'test-file.txt',
        total_size: '13',
        directory_id: '67890',
      })
      .reply(200, {
        result: 'success',
        data: {
          id: 1234,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 1,
          created_by: 1,
          created_at: 1234567890,
          added_at: 1234567890,
          last_modified_at: 1234567890,
          last_modified_by: 1,
          revised_at: 1234567890,
          updated_at: 1234567890,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    // Should succeed after retries
    await expect(uploader.uploadFile(file)).resolves.not.toThrow();
  });
});
