import { error, fail } from '@sveltejs/kit';
import type { AuthUser } from '../auth/users.ts';
import { getDb } from '../db/index.ts';
import { DomainError, type DomainErrorCode } from '../domain/errors.ts';
import type { Placement } from '../domain/rank.ts';
import { eventWindow } from '../events/log.ts';

const STATUS: Record<DomainErrorCode, number> = {
	invalid: 400,
	not_found: 404,
	conflict: 409,
	forbidden: 403
};

export function signedIn(locals: App.Locals): AuthUser {
	if (!locals.user) error(401, 'Sign in first');
	return locals.user;
}

// Runs a write. The result carries `seq`, the last seq once the write is done: a client holds its
// optimistic patch until its view has applied that seq. Read it with no await after the write, so
// no other write can come between.
export type Performed<T> = (T extends Record<string, unknown> ? T : unknown) & {
	scope: string;
	seq: number;
};

export function perform<T extends Record<string, unknown> | void>(scope: string, run: () => T) {
	try {
		const value = run();
		return { ...(value ?? {}), scope, seq: eventWindow(getDb()).last } as Performed<T>;
	} catch (e) {
		if (e instanceof DomainError) return fail(STATUS[e.code], { scope, error: e.message });
		throw e;
	}
}

export function text(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

export function int(form: FormData, name: string): number {
	const value = text(form, name).trim();
	if (!/^\d+$/.test(value)) throw new DomainError('invalid', `${name} must be a whole number`);
	return Number(value);
}

// An empty field is null.
export function optionalInt(form: FormData, name: string): number | null {
	return text(form, name).trim() === '' ? null : int(form, name);
}

export function checked(form: FormData, name: string): boolean {
	const value = text(form, name);
	return value === 'on' || value === 'true';
}

// `top`, `bottom`, `before:<id>` or `after:<id>`.
export function placement(form: FormData, name = 'placement'): Placement {
	const value = text(form, name);
	if (value === 'top' || value === 'bottom') return value;
	const match = /^(before|after):(\d+)$/.exec(value);
	if (!match)
		throw new DomainError('invalid', 'placement must be top, bottom, before:<id> or after:<id>');
	const id = Number(match[2]);
	return match[1] === 'before' ? { before: id } : { after: id };
}
