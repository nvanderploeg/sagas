import type { ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { getDb } from '#lib/server/db/index.ts';

export const init: ServerInit = () => {
	if (building) return;
	getDb();
};
