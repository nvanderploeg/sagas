import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { realms, users } from '#lib/server/db/schema.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import { createLabour, type LabourSpec } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';

export const TODO = { key: 'todo', label: 'To do', color: '#111111', icon: 'circle' };

// Seeds run one at a time, in call order, however a spec starts them.
let seeding: Promise<unknown> = Promise.resolve();
function inOrder<T>(task: () => Promise<T>): Promise<T> {
	const result = seeding.then(task, task);
	seeding = result.catch(() => undefined);
	return result;
}

async function insertUser(db: Db, username: string): Promise<number> {
	return (
		await db
			.insert(users)
			.values({ kind: 'human', username, displayName: username, realmLimit: 1000 })
			.returning({ id: users.id })
	)[0].id;
}

async function findOrInsertActor(db: Db): Promise<Actor> {
	const row = (
		await db.select({ id: users.id }).from(users).where(eq(users.username, 'actor')).limit(1)
	)[0];
	return row ?? { id: await insertUser(db, 'actor') };
}

export function seedUser(db: Db, username = 'ada'): Promise<number> {
	return inOrder(() => insertUser(db, username));
}

export function seedActor(db: Db): Promise<Actor> {
	return inOrder(() => findOrInsertActor(db));
}

export function seedRealm(db: Db, key = 'AM') {
	return inOrder(async () =>
		createRealm(db, await findOrInsertActor(db), {
			name: `Realm ${key}`,
			key,
			initialState: TODO
		})
	);
}

export function seedLabour(db: Db, spec: Partial<LabourSpec> & { realmId: number }) {
	return inOrder(async () => {
		const ownerId =
			spec.ownerId ?? (await insertUser(db, `owner${Math.random().toString(36).slice(2, 8)}`));
		return createLabour(db, await findOrInsertActor(db), { title: 'Labour', ownerId, ...spec });
	});
}

// A Realm for a Quest a spec does not care about: the first one, or a new one.
export async function anyRealmId(db: Db): Promise<number> {
	return (
		(await db.select({ id: realms.id }).from(realms).orderBy(realms.id).limit(1))[0]?.id ??
		(await seedRealm(db, 'QR')).id
	);
}
