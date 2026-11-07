import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import {
	GoogleAuthProvider,
	getAuth,
	isSignInWithEmailLink,
	sendSignInLinkToEmail,
	signInWithEmailLink,
	signInWithPopup,
	signOut,
	type UserCredential
} from 'firebase/auth';

const EMAIL_KEY = 'sagas:signin-email';

function auth(config: FirebaseOptions) {
	return getAuth(getApps()[0] ?? initializeApp(config));
}

// Hands the signed-in user's ID token to the server for a session cookie.
async function startSession(credential: UserCredential): Promise<void> {
	const response = await fetch('/api/auth/session', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ idToken: await credential.user.getIdToken() })
	});
	if (!response.ok) {
		await signOut(getAuth());
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'Sign-in failed');
	}
}

export async function signInWithGoogle(config: FirebaseOptions): Promise<void> {
	await startSession(await signInWithPopup(auth(config), new GoogleAuthProvider()));
}

export async function emailSignInLink(config: FirebaseOptions, email: string): Promise<void> {
	await sendSignInLinkToEmail(auth(config), email, {
		url: `${location.origin}/login${location.search}`,
		handleCodeInApp: true
	});
	try {
		localStorage.setItem(EMAIL_KEY, email);
	} catch {
		// The link page asks for the email again.
	}
}

export function arrivedByEmailLink(config: FirebaseOptions): boolean {
	return isSignInWithEmailLink(auth(config), location.href);
}

export function rememberedEmail(): string {
	try {
		return localStorage.getItem(EMAIL_KEY) ?? '';
	} catch {
		return '';
	}
}

export async function completeEmailLink(config: FirebaseOptions, email: string): Promise<void> {
	await startSession(await signInWithEmailLink(auth(config), email, location.href));
	try {
		localStorage.removeItem(EMAIL_KEY);
	} catch {
		// Nothing was stored.
	}
}

export async function firebaseSignOut(config: FirebaseOptions): Promise<void> {
	await signOut(auth(config));
}
