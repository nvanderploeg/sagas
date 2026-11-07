import { createPool, openDatabase, type Db } from './client.ts';
import { bootstrap } from './bootstrap.ts';
import { databaseUrl } from '../config.ts';

export { type Db } from './client.ts';
export * as schema from './schema.ts';

let instance: Db | undefined;

export function getDb(): Db {
	if (instance === undefined) instance = openDatabase(createPool(databaseUrl()));
	return instance;
}

export async function migrateDatabase(): Promise<void> {
	await bootstrap(getDb().$client);
}
