import pino from 'pino';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import handleShutdownSignals from '@/lib/shutdown';

import type { MockInstance } from 'vitest';

describe('handleShutdownSignals', () => {
  const initialExitCode = process.exitCode;
  let onSpy: MockInstance<typeof process.on>;

  beforeEach(() => {
    onSpy = vi.spyOn(process, 'on');
  });

  afterEach(() => {
    onSpy.mock.calls.forEach(([event, listener]) => process.off(event, listener));
    onSpy.mockRestore();
    process.exitCode = initialExitCode;
  });

  // Calls the registered handler directly: emitting a real signal would also reach vitest's own listeners.
  const sendSignal = (signal: NodeJS.Signals): void => {
    onSpy.mock.calls
      .filter(([event]) => event === signal)
      .forEach(([, listener]) => listener(signal));
  };

  it('should stop gracefully on the first signal', () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn();
    handleShutdownSignals(pino({ level: 'silent' }), { shutdown, cancel });

    sendSignal('SIGTERM');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(initialExitCode);
  });

  it('should cancel in-flight uploads and set exit code 1 on a second signal', () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn();
    handleShutdownSignals(pino({ level: 'silent' }), { shutdown, cancel });

    sendSignal('SIGTERM');
    sendSignal('SIGINT');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
