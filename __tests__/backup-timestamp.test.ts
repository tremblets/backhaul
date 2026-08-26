import { describe, expect, it } from 'vitest';

import { compareByRetentionKeyDesc, extractBackupTimestamp, splitByRetention } from '@/lib/backup-timestamp';

describe('extractBackupTimestamp', () => {
  it('should extract a dotted date-time timestamp', () => {
    expect(extractBackupTimestamp('sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip'))
      .toBe('20260814222605');
  });

  it('should extract a compact 14-digit timestamp', () => {
    expect(extractBackupTimestamp('jellyfin-backup-20260806103437.zip')).toBe('20260806103437');
  });

  it('should return null when no timestamp can be found', () => {
    expect(extractBackupTimestamp('backup-final.zip')).toBeNull();
  });
});

describe('compareByRetentionKeyDesc', () => {
  it('should sort by embedded timestamp, most recent first', () => {
    const names = [
      'jellyfin-backup-20260819103437.zip',
      'jellyfin-backup-20260821103437.zip',
      'jellyfin-backup-20260820103437.zip',
    ];

    expect([...names].sort(compareByRetentionKeyDesc)).toEqual([
      'jellyfin-backup-20260821103437.zip',
      'jellyfin-backup-20260820103437.zip',
      'jellyfin-backup-20260819103437.zip',
    ]);
  });

  it('should sort by the embedded date, not the full name, for version-prefixed names', () => {
    const names = [
      'sonarr_backup_v4.0.9.2000_2026.08.10_22.26.05.zip',
      'sonarr_backup_v4.0.20.3010_2026.08.18_22.26.05.zip',
      'sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip',
    ];

    expect([...names].sort(compareByRetentionKeyDesc)).toEqual([
      'sonarr_backup_v4.0.20.3010_2026.08.18_22.26.05.zip',
      'sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip',
      'sonarr_backup_v4.0.9.2000_2026.08.10_22.26.05.zip',
    ]);
  });

  it('should fall back to full-name comparison when a timestamp cannot be extracted', () => {
    const names = ['backup-b.zip', 'backup-a.zip', 'backup-c.zip'];

    expect([...names].sort(compareByRetentionKeyDesc)).toEqual([
      'backup-c.zip',
      'backup-b.zip',
      'backup-a.zip',
    ]);
  });
});

describe('splitByRetention', () => {
  it('should keep the N most recent items and put the rest in beyond', () => {
    const names = [
      'jellyfin-backup-20260819103437.zip',
      'jellyfin-backup-20260821103437.zip',
      'jellyfin-backup-20260820103437.zip',
    ];

    expect(splitByRetention(names, 2, (name) => name)).toEqual({
      kept: [
        'jellyfin-backup-20260821103437.zip',
        'jellyfin-backup-20260820103437.zip',
      ],
      beyond: ['jellyfin-backup-20260819103437.zip'],
    });
  });

  it('should put everything in kept and nothing in beyond when within the limit', () => {
    const names = ['a.zip', 'b.zip'];

    expect(splitByRetention(names, 3, (name) => name)).toEqual({
      kept: expect.arrayContaining(names),
      beyond: [],
    });
  });

  it('should work on arbitrary objects via the nameOf accessor', () => {
    const items = [
      { id: 1, name: 'backup-b.zip' },
      { id: 2, name: 'backup-a.zip' },
      { id: 3, name: 'backup-c.zip' },
    ];

    expect(splitByRetention(items, 1, (item) => item.name)).toEqual({
      kept: [{ id: 3, name: 'backup-c.zip' }],
      beyond: [{ id: 1, name: 'backup-b.zip' }, { id: 2, name: 'backup-a.zip' }],
    });
  });
});
