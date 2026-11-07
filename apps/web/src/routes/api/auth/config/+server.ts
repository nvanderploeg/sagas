import { json, type RequestHandler } from '@sveltejs/kit';
import { firebaseWebConfig } from '#lib/server/config.ts';

export const GET: RequestHandler = () => json(firebaseWebConfig);
