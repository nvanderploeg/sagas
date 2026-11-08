import { sql, type SQL } from 'drizzle-orm';

// One bound parameter however long the list: never `IN ($1, $2, ...)`, which caps at 65535.
export const intList = (ids: readonly number[]): SQL =>
	sql`(SELECT unnest(${sql.param(ids)}::int[]))`;

export const textList = (values: readonly string[]): SQL =>
	sql`(SELECT unnest(${sql.param(values)}::text[]))`;

export const intRows = (ids: readonly number[]): SQL => sql`unnest(${sql.param(ids)}::int[])`;
