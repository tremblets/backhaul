const BACKUP_TIMESTAMP_PATTERNS: RegExp[] = [
  // sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip
  /(\d{4})\.(\d{2})\.(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/,
  // jellyfin-backup-20260806103437.zip
  /(?<!\d)(\d{14})(?!\d)/,
];

export const extractBackupTimestamp = (name: string): string | null => {
  const match = BACKUP_TIMESTAMP_PATTERNS
    .map((pattern) => pattern.exec(name))
    .find((result): result is RegExpExecArray => result !== null);

  return match ? match.slice(1).join('') : null;
};

export const compareByRetentionKeyDesc = (nameA: string, nameB: string): number => {
  const keyA = extractBackupTimestamp(nameA) ?? nameA;
  const keyB = extractBackupTimestamp(nameB) ?? nameB;

  if (keyA === keyB) {
    return 0;
  }

  return keyA < keyB ? 1 : -1;
};

export interface RetentionSplit<T> {
  kept: T[];
  beyond: T[];
}

export const splitByRetention = <T>(
  items: T[],
  retention: number,
  nameOf: (item: T) => string,
): RetentionSplit<T> => {
  const sorted = [...items].sort((a, b) => compareByRetentionKeyDesc(nameOf(a), nameOf(b)));

  return { kept: sorted.slice(0, retention), beyond: sorted.slice(retention) };
};
