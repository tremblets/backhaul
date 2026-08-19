const sleep = async (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * HTTP Error class for distinguishing network errors from HTTP response errors
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Check if an error is retryable
 * - HttpError: retryable only if status is 5xx or 429 (transient)
 * - Other errors (network, timeout, etc): retryable by default
 */
export const isTransientError = (error: unknown): boolean => {
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 429;
  }
  return true;
};

interface WithRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Retry a function with exponential backoff and jitter
 * @param fn - The function to retry
 * @param options - Retry configuration
 * @returns The result of the function if successful
 * @throws If all retries are exhausted or the error is not retryable
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 250,
    maxDelayMs = 10_000,
    isRetryable = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      lastError = error;

      // If this was the last attempt or error is not retryable, throw immediately
      if (attempt === retries || !isRetryable(error)) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
      const jitteredDelay = delay * (0.5 + Math.random() * 0.5);

      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredDelay);
    }
  }

  throw lastError;
}
