import { openDatabase, type Db } from '#lib/server/db/client.ts';

export function testDb(): Db {
	return openDatabase(':memory:');
}
