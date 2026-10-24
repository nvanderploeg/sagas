import { eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { scrolls } from '../db/schema.ts';
import { DomainError } from './errors.ts';

export type Scroll = typeof scrolls.$inferSelect;

// The Event payload in docs/scrolls.md: the whole row, body included.
export type ScrollView = Scroll;

export type PathChange = { id: number; previousPath: string; path: string };

export function getScroll(db: Handle, scrollId: number): Scroll {
	const row = db.select().from(scrolls).where(eq(scrolls.id, scrollId)).get();
	if (row === undefined) throw new DomainError('not_found', 'Scroll not found');
	return row;
}

export const readScroll: (db: Handle, scrollId: number) => ScrollView = getScroll;
