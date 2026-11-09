import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { transact } from '#lib/server/db/tx.ts';
import { users } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { FirebaseIdentity } from './firebase.ts';
import { DELETED_USERNAME, toAuthUser, type AuthUser } from './users.ts';

const MAX_USERNAME = 32;

function baseUsername(email: string): string {
	const local = email
		.split('@')[0]
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '');
	const lettered = /^[a-z]/.test(local) ? local : `u${local}`;
	return lettered.slice(0, MAX_USERNAME - 5).padEnd(2, '0');
}

async function freeUsername(tx: Handle, email: string): Promise<string> {
	const base = baseUsername(email);
	for (let n = 0; ; n++) {
		const candidate = n === 0 ? base : `${base}${n + 1}`;
		if (candidate === DELETED_USERNAME) continue;
		const taken = (
			await tx.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)
		)[0];
		if (!taken) return candidate;
	}
}

// The one human Admin of an instance nobody has signed in to yet; with several, none is guessed.
async function soleUnlinkedAdmin(tx: Handle) {
	const linked = await tx
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.kind, 'human'), or(isNotNull(users.firebaseUid), isNotNull(users.email))))
		.limit(1);
	if (linked.length > 0) return undefined;
	const admins = await tx
		.select()
		.from(users)
		.where(and(eq(users.kind, 'human'), eq(users.isAdmin, true), isNull(users.firebaseUid)))
		.limit(2);
	return admins.length === 1 ? admins[0] : undefined;
}

// Resolves the human User for a Firebase identity: by uid, else by the verified email a User holds,
// else (listed admin email, no User linked yet) the sole human Admin, else a new User.
export async function signInIdentity(
	db: Db,
	identity: FirebaseIdentity,
	adminEmails: ReadonlySet<string>
): Promise<AuthUser> {
	if (!identity.email || !identity.emailVerified) {
		throw new DomainError('forbidden', 'Sign in with an account whose email is verified');
	}
	const email = identity.email;
	return transact(db, async (tx) => {
		const byUid = (
			await tx.select().from(users).where(eq(users.firebaseUid, identity.uid)).limit(1)
		)[0];
		const holder = (await tx.select().from(users).where(eq(users.email, email)).limit(1))[0];
		if (byUid && holder && holder.id !== byUid.id) {
			throw new DomainError('conflict', 'That email belongs to another account');
		}
		const byEmail = byUid ? undefined : holder;
		if (byEmail && (byEmail.kind !== 'human' || byEmail.firebaseUid !== null)) {
			throw new DomainError(
				'conflict',
				'That email belongs to an account linked to a different sign-in; an Admin can unlink it on /admin'
			);
		}
		const admin = adminEmails.has(email);
		const existing = byUid ?? byEmail ?? (admin ? await soleUnlinkedAdmin(tx) : undefined);
		if (existing) {
			const row = (
				await tx
					.update(users)
					.set({
						firebaseUid: identity.uid,
						email,
						isAdmin: existing.isAdmin || admin
					})
					.where(eq(users.id, existing.id))
					.returning()
			)[0];
			return toAuthUser(row);
		}
		const username = await freeUsername(tx, email);
		const displayName = (identity.name?.trim() || email.split('@')[0]).slice(0, 100);
		const row = (
			await tx
				.insert(users)
				.values({
					kind: 'human',
					isAdmin: admin,
					username,
					displayName,
					email,
					firebaseUid: identity.uid
				})
				.returning()
		)[0];
		return toAuthUser(row);
	});
}
