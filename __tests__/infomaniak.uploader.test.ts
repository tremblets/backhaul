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

const createUploader = (logger: Logger) => new InfomaniakProvider(logger, {
  folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890',
  token: 'test-token',
});

describe('InfomaniakProvider', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    nock.cleanAll();
  });

  it('should initialize the provider with the correct config', () => {
    const uploader = createUploader(createMockLogger());
    expect(uploader).toBeDefined();
  });

  it('should throw an error for invalid folder URL', () => {
    expect(() => new InfomaniakProvider(createMockLogger(), {
      folderUrl: 'invalid-url',
      token: 'test-token',
    })).toThrow('Invalid folder URL');
  });

  describe('hashFile', () => {
    it('should compute an xxh3 hash of the file content', async () => {
      const uploader = createUploader(createMockLogger());
      const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });

      const buffer = await file.arrayBuffer();
      const expectedHash = `xxh3:${XXHash.XXHash3.hash(Buffer.from(buffer)).toString('hex')}`;

      await expect(uploader.hashFile(file)).resolves.toBe(expectedHash);
    });
  });

  describe('resolveDestination', () => {
    it('should return the root folder id when no path is given', async () => {
      const uploader = createUploader(createMockLogger());
      await expect(uploader.resolveDestination()).resolves.toBe('67890');
    });

    it('should resolve nested folder paths with multiple segments', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/name')
        .query({ name: 'sub1' })
        .reply(200, {
          result: 'success',
          data: {
            id: 11111, name: 'sub1', type: 'dir', created_at: 1234567890,
          },
        });

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/11111/name')
        .query({ name: 'sub2' })
        .reply(200, {
          result: 'success',
          data: {
            id: 22222, name: 'sub2', type: 'dir', created_at: 1234567890,
          },
        });

      await expect(uploader.resolveDestination('sub1/sub2')).resolves.toBe('22222');
    });

    it('should return null when the target folder does not exist yet', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/name')
        .query({ name: 'missing' })
        .reply(200, {
          result: 'error',
          error: { code: 'file_not_found', description: 'File not found' },
        });

      await expect(uploader.resolveDestination('missing/path')).resolves.toBeNull();
    });

    it('should throw for non-404 errors while resolving a folder path', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/name')
        .query({ name: 'bad' })
        .reply(200, {
          result: 'error',
          error: { code: 'forbidden', description: 'Access denied' },
        });

      await expect(
        uploader.resolveDestination('bad/path'),
      ).rejects.toThrow(/Failed to find/);
    });
  });

  describe('listFiles', () => {
    it('should list remote files, mapped to ProviderFile', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash' })
        .reply(200, {
          result: 'success',
          data: [
            {
              id: 1234, name: 'test-file.txt', type: 'file', hash: 'xxh3:abc',
            },
          ],
          cursor: '',
          has_more: false,
          response_at: Math.floor(Date.now() / 1000),
        });

      await expect(uploader.listFiles('67890')).resolves.toEqual([
        { id: '1234', name: 'test-file.txt', hash: 'xxh3:abc' },
      ]);
    });

    it('should handle pagination when listing files', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash' })
        .reply(200, {
          result: 'success',
          data: [{
            id: 1, name: 'file1.txt', type: 'file', hash: 'xxh3:hash1',
          }],
          cursor: 'cursor_page2',
          has_more: true,
          response_at: Math.floor(Date.now() / 1000),
        });

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash', cursor: 'cursor_page2' })
        .reply(200, {
          result: 'success',
          data: [{
            id: 2, name: 'file2.txt', type: 'file', hash: 'xxh3:hash2',
          }],
          cursor: '',
          has_more: false,
          response_at: Math.floor(Date.now() / 1000),
        });

      await expect(uploader.listFiles('67890')).resolves.toEqual([
        { id: '1', name: 'file1.txt', hash: 'xxh3:hash1' },
        { id: '2', name: 'file2.txt', hash: 'xxh3:hash2' },
      ]);
    });

    it('should retry transient 500 errors and eventually succeed', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash' })
        .reply(500, { result: 'error', error: { code: 'internal_error', description: 'oops' } });

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash' })
        .reply(500, { result: 'error', error: { code: 'internal_error', description: 'oops' } });

      nock('https://api.infomaniak.com')
        .get('/3/drive/12345/files/67890/files')
        .query({ with: 'hash' })
        .reply(200, {
          result: 'success', data: [], cursor: '', has_more: false, response_at: 0,
        });

      await expect(uploader.listFiles('67890')).resolves.toEqual([]);
    });
  });

  describe('uploadFile', () => {
    it('should upload a file without listing or resolving the destination first', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .post('/3/drive/12345/upload')
        .query({
          file_name: 'test-file.txt',
          total_size: '13',
          directory_id: '67890',
        })
        .reply(200, {
          result: 'success',
          data: { id: 1234, name: 'test-file.txt' },
        });

      const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
      await expect(uploader.uploadFile(file)).resolves.toBeUndefined();
    });

    it('should upload to a nested destination path via directory_path', async () => {
      const uploader = createUploader(createMockLogger());

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
          data: { id: 1234, name: 'test-file.txt' },
        });

      const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
      await expect(uploader.uploadFile(file, 'sub1/sub2')).resolves.toBeUndefined();
    });

    it('should throw when the upload request fails', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .post('/3/drive/12345/upload')
        .query({ file_name: 'test-file.txt', total_size: '13', directory_id: '67890' })
        .reply(400, {
          result: 'error',
          error: { code: 'upload_not_terminated_error', description: 'Invalid request parameters' },
        });

      const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
      await expect(uploader.uploadFile(file)).rejects.toThrow('Failed to initiate upload');
    });

    it('should throw when the upload API responds with an error result', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .post('/3/drive/12345/upload')
        .query({ file_name: 'test-file.txt', total_size: '13', directory_id: '67890' })
        .reply(200, {
          result: 'error',
          error: { code: 'upload_not_terminated_error', description: 'Invalid request parameters' },
        });

      const file = new File(['Hello, world!'], 'test-file.txt', { type: 'text/plain' });
      await expect(uploader.uploadFile(file)).rejects.toThrow('Upload error');
    });
  });

  describe('deleteFile', () => {
    it('should move the file to trash and then purge it', async () => {
      const uploader = createUploader(createMockLogger());

      const deleteScope = nock('https://api.infomaniak.com')
        .delete('/2/drive/12345/files/100')
        .reply(200, { result: 'success', data: { cancel_id: 'cancel-100', valid_until: 1234567900 } });

      const purgeScope = nock('https://api.infomaniak.com')
        .delete('/2/drive/12345/trash/100')
        .reply(200, { result: 'success', data: true });

      await uploader.deleteFile({ id: '100', name: 'backup.zip' });

      expect(deleteScope.isDone()).toBe(true);
      expect(purgeScope.isDone()).toBe(true);
    });

    it('should propagate an error when the delete request fails', async () => {
      const uploader = createUploader(createMockLogger());

      nock('https://api.infomaniak.com')
        .delete('/2/drive/12345/files/200')
        .reply(500, { result: 'error', error: { code: 'internal_error', description: 'oops' } });

      await expect(
        uploader.deleteFile({ id: '200', name: 'backup.zip' }),
      ).rejects.toThrow();
    });
  });
});
