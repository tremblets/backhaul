/* eslint-disable n/no-sync */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

const CONFIG_FOLDER = process.env.NODE_ENV === 'development'
  ? './'
  : './config';
export const DATA_FOLDER = './data';

const envSchema = z.object({
  TZ: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const secretsSchema = z.object({
  INFOMANIAK_API_KEY: z.string().min(1, 'INFOMANIAK_API_KEY is required'),
});

export type Secrets = z.infer<typeof secretsSchema>;

export const env = envSchema.parse(process.env);

const getSecret = (id: string): string => {
  const dockerSecretPath = `/run/secrets/${id}`;

  if (existsSync(dockerSecretPath)) {
    return readFileSync(dockerSecretPath, 'utf-8').trim();
  }

  const envKey = id.toUpperCase();
  if (process.env[envKey]) {
    return process.env[envKey]!.trim();
  }

  throw new Error(`[CRITICAL] Le secret '${id}' est introuvable (vérifiez /run/secrets/ ou process.env.${envKey})`);
};

export const secrets = secretsSchema.parse({
  INFOMANIAK_API_KEY: getSecret('infomaniak_api_key'),
});

const configSchema = z.object({
  schedule: z.string().min(9, 'Schedule is required').default('0 0 * * *'),
  infomaniak: z.object({
    folderUrl: z.url('Invalid folder URL'),
  }).required(),
  folders: z.array(z.object({
    source: z.string().min(1, 'Source folder is required'),
    destination: z.string().min(1, 'Destination folder is required'),
  })).min(1, 'At least one folder mapping is required'),
});

export type Config = z.infer<typeof configSchema>;

export const loadConfig = async (folder: string = CONFIG_FOLDER): Promise<Config> => {
  const configPath = path.resolve(folder, 'config.yml');
  const file = await readFile(configPath, 'utf-8');
  const parsed = YAML.parse(file);
  return configSchema.parse(parsed);
};
