import { json } from '@sveltejs/kit';
import { unauthorizedResponse } from '../auth/access.ts';
import { DomainError } from '../domain/errors.ts';
import { toJson } from './reads.ts';

export function answerSession(locals: App.Locals, read: () => unknown): Response {
	if (!locals.user || locals.credential?.kind !== 'session') return unauthorizedResponse();
	try {
		return json(toJson(read()));
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') {
			return json({ error: 'not found' }, { status: 404 });
		}
		throw error;
	}
}

export function idParam(raw: string): number {
	if (!/^\d{1,15}$/.test(raw)) throw new DomainError('not_found', 'Not found');
	return Number(raw);
}
