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

  it('should apply retention and delete oldest files when exceeding limit', async () => {
    const logger = createMockLogger();
    const uploader = new InfomaniakProvider(logger, {
      folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
      token: 'test-token',
    });

    // Mock listing files - returns 3 files, each with different created_at
    nock('https://api.infomaniak.com')
      .get('/3/drive/12345/files/67890/files')
      .query({ with: 'hash' })
      .reply(200, {
        result: 'success',
        data: [
          {
            id: 100,
            name: 'old-file.txt',
            type: 'file',
            created_at: 1234567890,
            hash: 'xxh3:hash-old',
          },
          {
            id: 101,
            name: 'medium-file.txt',
            type: 'file',
            created_at: 1234567891,
            hash: 'xxh3:hash-medium',
          },
          {
            id: 102,
            name: 'new-file.txt',
            type: 'file',
            created_at: 1234567892,
            hash: 'xxh3:hash-new',
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
          id: 103,
          name: 'test-file.txt',
          type: 'file',
          status: 'ok',
          visibility: 'is_in_private_space',
          drive_id: 12345,
          depth: 1,
          created_by: 1,
          created_at: 1234567893,
          added_at: 1234567893,
          last_modified_at: 1234567893,
          last_modified_by: 1,
          revised_at: 1234567893,
          updated_at: 1234567893,
          parent_id: 67890,
          size: 13,
          mime_type: 'text/plain',
          extension_type: 'txt',
          scan_status: 'to_be_scan',
        },
      });

    // Mock DELETE calls for old files (keeping only 2, so delete id 100)
    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/100')
      .reply(200, {
        result: 'success',
        data: {
          cancel_id: 'cancel-123',
          valid_until: 1234567900,
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    await expect(uploader.uploadFile(file, undefined, { retention: 2 })).resolves.not.toThrow();
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
            name: 'old-file.txt',
            type: 'file',
            created_at: 1234567890,
            hash: 'xxh3:hash-old',
          },
          {
            id: 201,
            name: 'new-file.txt',
            type: 'file',
            created_at: 1234567891,
            hash: 'xxh3:hash-new',
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
          id: 202,
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

    // Mock DELETE call that fails (HTTP error)
    nock('https://api.infomaniak.com')
      .delete('/2/drive/12345/files/200')
      .reply(500, {
        result: 'error',
        error: {
          code: 'internal_error',
          description: 'Internal server error',
        },
      });

    const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
    // Even though DELETE fails, uploadFile should succeed (Promise.allSettled behavior)
    await expect(uploader.uploadFile(file, undefined, { retention: 1 })).resolves.not.toThrow();
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
