import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Cron } from 'croner';
import YAML from 'yaml';
import { z } from 'zod';

export const DATA_FOLDER = '/data';
export const CRON_MODE = '5-part';
const CONFIG_FILE_NAME = 'config.yml';
const CONFIG_FOLDER = '/config';

const cronSchema = z.string()
  .refine(
    (schedule) => schedule.trim().split(/\s+/).length === 5,
    { error: 'Schedule must be a standard 5-field cron expression', abort: true },
  )
  .refine(
    (schedule) => {
      try {
        // eslint-disable-next-line no-new
        new Cron(schedule, { mode: CRON_MODE });
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

const defaultsSchema = z.strictObject({
  retention: retentionSchema.default(3),
}).prefault({});

const infomaniakUrlSchema = z.url({
  protocol: /^https$/,
  hostname: /^ksuite.infomaniak\.com$/,
  error: 'Must be a valid KDrive URL starting with https://ksuite.infomaniak.com',
});

const normalizeDestination = (destination: string): string => {
  const normalized = path.posix.normalize(`/${destination}`);

  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const foldersSchema = z.array(z.strictObject({
  source: z.string().min(1, 'Source folder is required'),
  destination: z.string().min(1, 'Destination folder is required'),
  retention: retentionSchema.optional(),
}))
  .min(1, 'At least one folder mapping is required')
  .superRefine((folders, ctx) => {
    const firstIndexByDestination = new Map<string, number>();

    folders.forEach((folder, index) => {
      const destination = normalizeDestination(folder.destination);
      const firstIndex = firstIndexByDestination.get(destination);

      if (firstIndex === undefined) {
        firstIndexByDestination.set(destination, index);
        return;
      }

      ctx.addIssue({
        code: 'custom',
        path: [index, 'destination'],
        message: `Destination "${destination}" is already used by folders.${firstIndex}`,
      });
    });
  });

const configSchema = z.strictObject({
  schedule: cronSchema,
  runOnStart: z.boolean().default(false),
  defaults: defaultsSchema,
  infomaniak: z.strictObject({
    folderUrl: infomaniakUrlSchema,
  }),
  folders: foldersSchema,
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
