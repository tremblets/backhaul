import { describe, expect, it } from 'vitest';

import { env } from '@/env';

describe('Env', () => {
  it('should have NODE_ENV defined', () => {
    expect(['development', 'test', 'production']).toContain(env.NODE_ENV);
  });
});
