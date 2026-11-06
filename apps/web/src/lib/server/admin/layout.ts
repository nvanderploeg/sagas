import { join } from 'node:path';
import { attachmentsDir, dataDir, databasePath } from '#lib/server/config.ts';

export type DataLayout = {
	databaseFile: string;
	attachmentsDir: string;
	dataDir: string;
};

export const dataLayout: DataLayout = { databaseFile: databasePath, attachmentsDir, dataDir };

export const pendingDir = (layout: DataLayout) => join(layout.dataDir, 'import-pending');
export const backupsDir = (layout: DataLayout) => join(layout.dataDir, 'backups');
export const quarantineDir = (layout: DataLayout) => join(layout.dataDir, 'quarantine');
