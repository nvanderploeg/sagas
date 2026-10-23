import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { realms, users } from '#lib/server/db/schema.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import { createLabour, type LabourSpec } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';

export const TODO = { key: 'todo', label: 'To do', color: '#111111', icon: 'circle' };

export function seedUser(db: Db, username = 'ada'): number {
	return db
		.insert(users)
		.values({ kind: 'human', username, displayName: username, passwordHash: 'hash' })
		.returning({ id: users.id })
		.get().id;
}

export function seedActor(db: Db): Actor {
	const row = db.select({ id: users.id }).from(users).where(eq(users.username, 'actor')).get();
	return row ?? { id: seedUser(db, 'actor') };
}

export function seedRealm(db: Db, key = 'AM') {
	return createRealm(db, seedActor(db), { name: `Realm ${key}`, key, initialState: TODO });
}

export function seedLabour(db: Db, spec: Partial<LabourSpec> & { realmId: number }) {
	const ownerId = spec.ownerId ?? seedUser(db, `owner${Math.random().toString(36).slice(2, 8)}`);
	return createLabour(db, seedActor(db), { title: 'Labour', ownerId, ...spec });
}

// A Realm for a Quest a spec does not care about: the first one, or a new one.
export function anyRealmId(db: Db): number {
	return (
		db.select({ id: realms.id }).from(realms).orderBy(realms.id).get()?.id ?? seedRealm(db, 'QR').id
	);
}
