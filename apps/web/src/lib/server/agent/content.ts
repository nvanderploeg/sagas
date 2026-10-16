import { createHash } from 'node:crypto';
import type { Handle } from '../db/client.ts';
import { listComments } from '../domain/comments.ts';
import { getLabour } from '../domain/lookup.ts';

export type HashedContent = {
	title: string;
	description: string;
	labels: string[];
	comments: string[];
};

// Per docs/agent-layer-data.md, Hashes: key order and the inputs are part of the hash.
export function hashContent({ title, description, labels, comments }: HashedContent): string {
	return createHash('sha256')
		.update(JSON.stringify({ title, description, labels, comments }))
		.digest('hex');
}

export function contentHash(db: Handle, labourId: number): string {
	const { title, description, labels } = getLabour(db, labourId);
	const comments = listComments(db, labourId).map((comment) => comment.body);
	return hashContent({ title, description, labels, comments });
}
