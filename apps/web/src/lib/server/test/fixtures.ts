import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { createProject } from '#lib/server/domain/projects.ts';
import { createTicket, type TicketSpec } from '#lib/server/domain/tickets.ts';
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

export function seedProject(db: Db, key = 'AM') {
	return createProject(db, seedActor(db), { name: `Project ${key}`, key, initialState: TODO });
}

export function seedTicket(db: Db, spec: Partial<TicketSpec> & { projectId: number }) {
	const ownerId = spec.ownerId ?? seedUser(db, `owner${Math.random().toString(36).slice(2, 8)}`);
	return createTicket(db, seedActor(db), { title: 'Ticket', ownerId, ...spec });
}
