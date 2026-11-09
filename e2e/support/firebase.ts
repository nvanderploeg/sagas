import { authHost, authPort, firebaseProject } from './env.ts';

const base = `http://${authHost}:${authPort}/identitytoolkit.googleapis.com/v1`;
const PASSWORD = 'e2e-password-1';

type Reply = { localId?: string; idToken?: string };

async function call(path: string, body: object, owner = false): Promise<Reply> {
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(owner ? { authorization: 'Bearer owner' } : {})
		},
		body: JSON.stringify(body)
	});
	const json = (await response.json()) as Reply;
	if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
	return json;
}

// A fresh ID token for a verified account holding `email`, created on first use.
export async function idToken(email: string): Promise<string> {
	let signedIn: Reply;
	try {
		signedIn = await call('/accounts:signInWithPassword?key=e2e', {
			email,
			password: PASSWORD,
			returnSecureToken: true
		});
	} catch {
		signedIn = await call('/accounts:signUp?key=e2e', {
			email,
			password: PASSWORD,
			returnSecureToken: true
		});
		await call(
			`/projects/${firebaseProject}/accounts:update`,
			{ localId: signedIn.localId, emailVerified: true },
			true
		);
		signedIn = await call('/accounts:signInWithPassword?key=e2e', {
			email,
			password: PASSWORD,
			returnSecureToken: true
		});
	}
	return signedIn.idToken as string;
}
