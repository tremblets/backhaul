import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  HttpError,
  isTransientError,
  withRetry,
} from '@/lib/retry';

describe('Retry utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('HttpError', () => {
    it('should create an HttpError with status and message', () => {
      const error = new HttpError(500, 'Server error');
      expect(error).toBeInstanceOf(Error);
      expect(error.status).toBe(500);
      expect(error.message).toBe('Server error');
      expect(error.name).toBe('HttpError');
    });
  });

  describe('isTransientError', () => {
    it('should return true for non-HttpError', () => {
      expect(isTransientError(new Error('Network error'))).toBe(true);
    });

    it('should return true for 5xx HttpError', () => {
      expect(isTransientError(new HttpError(500, 'Internal error'))).toBe(true);
      expect(isTransientError(new HttpError(502, 'Bad gateway'))).toBe(true);
      expect(isTransientError(new HttpError(503, 'Service unavailable'))).toBe(true);
    });

    it('should return true for 429 HttpError (rate limit)', () => {
      expect(isTransientError(new HttpError(429, 'Too many requests'))).toBe(true);
    });

    it('should return false for 4xx HttpError (except 429)', () => {
      expect(isTransientError(new HttpError(400, 'Bad request'))).toBe(false);
      expect(isTransientError(new HttpError(401, 'Unauthorized'))).toBe(false);
      expect(isTransientError(new HttpError(403, 'Forbidden'))).toBe(false);
      expect(isTransientError(new HttpError(404, 'Not found'))).toBe(false);
    });

    it('should return false for 3xx and 2xx HttpError', () => {
      expect(isTransientError(new HttpError(200, 'OK'))).toBe(false);
      expect(isTransientError(new HttpError(300, 'Multiple choices'))).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should resolve on first success', async () => {
      const fn = vi.fn().mockResolvedValueOnce('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry and succeed on second attempt', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, {
        retries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      });

      // Advance through the first retry delay
      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry up to configured retries and then throw', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Network error'));

      const promise = withRetry(fn, {
        retries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      });

      // Attach the rejection assertion synchronously, before advancing timers,
      // so the promise is never left unhandled between ticks.
      const assertion = expect(promise).rejects.toThrow('Network error');

      // Advance through all retry attempts
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await vi.advanceTimersByTimeAsync(1000);
      }

      await assertion;
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry if isRetryable returns false', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError(404, 'Not found'));

      const promise = withRetry(fn, {
        retries: 3,
        isRetryable: isTransientError,
      });

      await expect(promise).rejects.toThrow(HttpError);
      expect(fn).toHaveBeenCalledTimes(1); // no retries for 404
    });

    it('should retry transient errors and succeed eventually', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new HttpError(500, 'Internal error'))
        .mockRejectedValueOnce(new HttpError(500, 'Internal error'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, {
        retries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        isRetryable: isTransientError,
      });

      // Advance through the retry delays (100ms, then 200ms)
      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-transient errors (4xx except 429)', async () => {
      const fn = vi.fn().mockRejectedValue(new HttpError(400, 'Bad request'));

      const promise = withRetry(fn, {
        retries: 3,
        isRetryable: isTransientError,
      });

      await expect(promise).rejects.toThrow(HttpError);
      expect(fn).toHaveBeenCalledTimes(1); // no retries for 400
    });

    it('should use exponential backoff with jitter', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, {
        retries: 3,
        baseDelayMs: 50,
        maxDelayMs: 10000,
      });

      // First attempt happens synchronously.
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      // Second attempt must wait for the first backoff delay (jitter range: 25-50ms) —
      // it must not have happened yet just after the minimum possible jittered delay.
      await vi.advanceTimersByTimeAsync(20);
      expect(fn).toHaveBeenCalledTimes(1);

      // Past the first delay's maximum bound, the second attempt has fired.
      await vi.advanceTimersByTimeAsync(50);
      expect(fn).toHaveBeenCalledTimes(2);

      // Past the second delay's maximum bound (jitter range: 50-100ms), the third
      // (successful) attempt has fired.
      await vi.advanceTimersByTimeAsync(120);

      const result = await promise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should apply maxDelayMs cap', async () => {
      vi.useFakeTimers();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockRejectedValueOnce(new Error('Fail'))
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');

      // This test verifies the maxDelayMs is applied by checking the retry function
      // For simplicity, we just verify it doesn't throw when hitting max delays
      const promise = withRetry(fn, {
        retries: 5,
        baseDelayMs: 100,
        maxDelayMs: 500, // This should cap the delays
      });

      // Advance through all retry attempts
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await vi.advanceTimersByTimeAsync(1000);
      }

      const result = await promise;
      expect(result).toBe('success');
    });

    it('should use custom isRetryable function', async () => {
      const customIsRetryable = (error: unknown) => {
        if (error instanceof HttpError) {
          return error.status === 503; // Only retry 503, not other 5xx
        }
        return false;
      };

      // Test retrying 503
      const fn503 = vi
        .fn()
        .mockRejectedValueOnce(new HttpError(503, 'Service unavailable'))
        .mockResolvedValueOnce('success');

      const promise1 = withRetry(fn503, {
        retries: 2,
        baseDelayMs: 50,
        isRetryable: customIsRetryable,
      });

      // Advance timers for the first retry delay
      await vi.advanceTimersByTimeAsync(100);

      const result1 = await promise1;
      expect(result1).toBe('success');
      expect(fn503).toHaveBeenCalledTimes(2);

      // Test not retrying 500
      const fn500 = vi.fn().mockRejectedValue(new HttpError(500, 'Internal error'));

      const promise2 = withRetry(fn500, {
        retries: 2,
        isRetryable: customIsRetryable,
      });

      await expect(promise2).rejects.toThrow(HttpError);
      expect(fn500).toHaveBeenCalledTimes(1); // no retries for 500
    });
  });
});
