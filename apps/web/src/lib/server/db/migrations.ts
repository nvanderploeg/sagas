import { createHash } from 'node:crypto';
import type { MigrationMeta } from 'drizzle-orm/migrator';

// Bundled at build time so the server does not depend on the working directory.
const sqlFiles = import.meta.glob('../../../../drizzle/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const journals = import.meta.glob('../../../../drizzle/meta/_journal.json', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

type Journal = { entries: { tag: string; when: number; breakpoints: boolean }[] };

export function loadMigrations(): MigrationMeta[] {
	const [journalText] = Object.values(journals);
	if (journalText === undefined) throw new Error('drizzle/meta/_journal.json is not bundled');

	return (JSON.parse(journalText) as Journal).entries.map((entry) => {
		const query = sqlFiles[`../../../../drizzle/${entry.tag}.sql`];
		if (query === undefined) throw new Error(`drizzle/${entry.tag}.sql is not bundled`);
		return {
			sql: query.split('--> statement-breakpoint'),
			bps: entry.breakpoints,
			folderMillis: entry.when,
			hash: createHash('sha256').update(query).digest('hex')
		};
	});
}
