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

export async function contentHash(db: Handle, labourId: number): Promise<string> {
	const { title, description, labels } = await getLabour(db, labourId);
	const comments = (await listComments(db, labourId)).map((comment) => comment.body);
	return hashContent({ title, description, labels, comments });
}
