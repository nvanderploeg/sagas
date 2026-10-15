import { openDatabase, type Db } from '../../apps/web/src/lib/server/db/client.ts';
import { createInvite } from '../../apps/web/src/lib/server/auth/invites.ts';
import { createApiToken, revokeApiToken } from '../../apps/web/src/lib/server/auth/tokens.ts';
import { findUser } from '../../apps/web/src/lib/server/auth/users.ts';
import { createProject } from '../../apps/web/src/lib/server/domain/projects.ts';
import { createTicket } from '../../apps/web/src/lib/server/domain/tickets.ts';
import { eventWindow, pruneEvents } from '../../apps/web/src/lib/server/events/log.ts';
import { databasePath } from './env.ts';

export type { Db };

export function openRunDb(): Db {
	return openDatabase(databasePath);
}

export type IssuedToken = { id: number; token: string; revoke: () => void };

const TODO = { key: 'todo', label: 'To do', color: '#111111', icon: 'circle' };

function randomKey(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let key = 'K';
	for (let i = 0; i < 4; i++) key += alphabet[Math.floor(Math.random() * alphabet.length)];
	return key;
}

// Writes go straight to the run's DB file with the admin as actor. The server's event bus is
// in-process, so a seeded write reaches a Stream only by replay, never live.
export function createSeed(db: Db, adminId: number) {
	const admin = findUser(db, adminId);
	if (!admin) throw new Error(`no user ${adminId} in the run database`);

	return {
		project(input: { key?: string; name?: string } = {}) {
			const key = input.key ?? randomKey();
			return createProject(db, admin, {
				name: input.name ?? `Project ${key}`,
				key,
				initialState: TODO
			});
		},

		ticket(projectId: number, input: { title?: string } = {}) {
			return createTicket(db, admin, {
				projectId,
				title: input.title ?? 'Ticket',
				ownerId: admin.id
			});
		},

		invite(): { id: number; token: string } {
			return createInvite(db, admin);
		},

		apiToken(userId: number = admin.id, name = 'e2e'): IssuedToken {
			const { id, token } = createApiToken(db, admin, userId, name);
			return { id, token, revoke: () => revokeApiToken(db, admin, id) };
		},

		lastSeq(): number {
			return eventWindow(db).last;
		},

		// Drops every retained Event, so any earlier seq becomes unreplayable.
		pruneAllEvents(): void {
			pruneEvents(db, 1, Date.now() + 24 * 60 * 60 * 1000);
		}
	};
}

export type Seed = ReturnType<typeof createSeed>;
