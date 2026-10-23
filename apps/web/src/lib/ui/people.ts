import { personColors } from './contrast.ts';

// Invalidating this loads the People directory again.
export const PEOPLE = 'app:people';

export type Person = {
	id: number;
	kind: 'human' | 'agent';
	username: string;
	displayName: string;
	via?: { name: string } | null;
};

export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// A stable hue per User, from the username: the same person keeps one colour everywhere.
export function hue(username: string): number {
	let hash = 2166136261;
	for (let i = 0; i < username.length; i++) {
		hash ^= username.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 360;
}

export function personColor(username: string): string {
	return personColors(hue(username)).background;
}

export function directory(people: Person[]): Map<number, Person> {
	return new Map(people.map((p) => [p.id, p]));
}
