import { databasePath } from '#lib/server/config.ts';
import { openDatabase, type Db } from './client.ts';

export { openDatabase, type Db } from './client.ts';
export * as schema from './schema.ts';

let instance: Db | undefined;

export function getDb(): Db {
	instance ??= openDatabase(databasePath);
	return instance;
}
