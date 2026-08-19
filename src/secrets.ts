import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const secretsSchema = z.object({
  INFOMANIAK_API_KEY: z.string().min(1, 'INFOMANIAK_API_KEY is required'),
});

export type Secrets = z.infer<typeof secretsSchema>;

const getSecret = async (id: string): Promise<string> => {
  const dockerSecretPath = `/run/secrets/${id}`;
  const envKey = id.toUpperCase();

  try {
    return (await readFile(dockerSecretPath, 'utf-8')).trim();
  } catch {
    // Continue to check environment variable
  }

  const envValue = process.env[envKey];
  if (envValue) {
    return envValue.trim();
  }

  throw new Error(
    `Secret '${id}' not found. Please provide it via /run/secrets/${id} or environment variable ${envKey}.`,
  );
};

export const loadSecrets = async (): Promise<Secrets> => {
  const parsed = {
    INFOMANIAK_API_KEY: await getSecret('infomaniak_api_key'),
  };
  return secretsSchema.parse(parsed);
};
