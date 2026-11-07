import { createPool, openDatabase, type Db } from '../../apps/web/src/lib/server/db/client.ts';
import { createApiToken, revokeApiToken } from '../../apps/web/src/lib/server/auth/tokens.ts';
import { findUser } from '../../apps/web/src/lib/server/auth/users.ts';
import { createRealm } from '../../apps/web/src/lib/server/domain/realms.ts';
import { createLabour } from '../../apps/web/src/lib/server/domain/labours.ts';
import { eventWindow, pruneEvents } from '../../apps/web/src/lib/server/events/log.ts';
import { databaseUrl } from './env.ts';

export type { Db };

export function openRunDb(): Db {
	return openDatabase(createPool(databaseUrl, { max: 3 }));
}

export type IssuedToken = { id: number; token: string; revoke: () => Promise<void> };

const TODO = { key: 'todo', label: 'To do', color: '#111111', icon: 'circle' };

function randomKey(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let key = 'K';
	for (let i = 0; i < 4; i++) key += alphabet[Math.floor(Math.random() * alphabet.length)];
	return key;
}

// Writes go straight to the run's DB file with the admin as actor. The server's event bus is
// in-process, so a seeded write reaches a Stream only by replay, never live.
export async function createSeed(db: Db, adminId: number) {
	const admin = await findUser(db, adminId);
	if (!admin) throw new Error(`no user ${adminId} in the run database`);

	return {
		realm(input: { key?: string; name?: string } = {}) {
			const key = input.key ?? randomKey();
			return createRealm(db, admin, {
				name: input.name ?? `Realm ${key}`,
				key,
				initialState: TODO
			});
		},

		labour(realmId: number, input: { title?: string } = {}) {
			return createLabour(db, admin, {
				realmId,
				title: input.title ?? 'Labour',
				ownerId: admin.id
			});
		},

		async apiToken(userId: number = admin.id, name = 'e2e'): Promise<IssuedToken> {
			const { id, token } = await createApiToken(db, admin, userId, name);
			return { id, token, revoke: () => revokeApiToken(db, admin, id) };
		},

		async lastSeq(): Promise<number> {
			return (await eventWindow(db)).last;
		},

		// Drops every retained Event, so any earlier seq becomes unreplayable.
		async pruneAllEvents(): Promise<void> {
			await pruneEvents(db, 1, Date.now() + 24 * 60 * 60 * 1000);
		}
	};
}

export type Seed = Awaited<ReturnType<typeof createSeed>>;
