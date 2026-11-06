import { applyPendingImport } from '#lib/server/admin/apply.ts';
import { dataLayout } from '#lib/server/admin/layout.ts';
import { databasePath } from '#lib/server/config.ts';
import { openDatabase, type Db } from './client.ts';

export { openDatabase, type Db } from './client.ts';
export * as schema from './schema.ts';

let instance: Db | undefined;

export function getDb(): Db {
	if (instance === undefined) {
		applyPendingImport(dataLayout);
		instance = openDatabase(databasePath);
	}
	return instance;
}
