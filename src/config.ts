import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Cron } from 'croner';
import YAML from 'yaml';
import { z } from 'zod';

export const DATA_FOLDER = '/data';
const CONFIG_FILE_NAME = 'config.yml';
const CONFIG_FOLDER = '/config';

const cronSchema = z.string()
  .min(9, 'Schedule is required')
  .refine(
    (schedule) => {
      try {
        // eslint-disable-next-line no-new
        new Cron(schedule);
        return true;
      } catch {
        return false;
      }
    },
    'Invalid cron expression',
  )
  .default('0 0 * * *');

const retentionSchema = z.union([
  z.int().min(1),
  z.literal(false),
]);

export type Retention = z.infer<typeof retentionSchema>;

const defaultsSchema = z.object({
  retention: retentionSchema.default(3),
}).prefault({});

const infomaniakUrlSchema = z.url({
  protocol: /^https$/,
  hostname: /^ksuite.infomaniak\.com$/,
  error: 'Must be a valid KDrive URL starting with https://ksuite.infomaniak.com',
});

const configSchema = z.object({
  schedule: cronSchema,
  defaults: defaultsSchema,
  infomaniak: z.object({
    folderUrl: infomaniakUrlSchema,
  }).required(),
  folders: z.array(z.object({
    source: z.string().min(1, 'Source folder is required'),
    destination: z.string().min(1, 'Destination folder is required'),
    retention: retentionSchema.optional(),
  })).min(1, 'At least one folder mapping is required'),
});

export type Config = z.infer<typeof configSchema>;

export type ResolvedFolder = Omit<Config['folders'][number], 'retention'> & {
  retention: Retention;
};

export const resolveFolders = (config: Config): ResolvedFolder[] => config.folders.map(
  (folder) => ({
    ...folder,
    retention: folder.retention ?? config.defaults.retention,
  }),
);

export const loadConfig = async (
  folder: string = CONFIG_FOLDER,
  fileName: string = CONFIG_FILE_NAME,
): Promise<Config> => {
  const configPath = path.resolve(folder, fileName);
  try {
    const file = await readFile(configPath, 'utf-8');
    const parsed = YAML.parse(file);
    return configSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorDetails = error.issues
        .map((issue) => {
          const fieldPath = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
          return `${fieldPath}${issue.message}`;
        })
        .join(', ');
      throw new Error(`Invalid config at ${configPath}: ${errorDetails}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config from ${configPath}: ${message}`);
  }
};
