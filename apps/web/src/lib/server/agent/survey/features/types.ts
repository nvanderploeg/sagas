import type { Handle } from '../../../db/client.ts';
import type { Candidate } from '../candidates.ts';

export type FeatureContext = {
	db: Handle;
	// In board order.
	candidates: Candidate[];
	// Bind through intList or intRows, never one parameter per id.
	candidateIds: number[];
	// Present when `needsQuery` is set.
	query: string | undefined;
	forUserId: number;
	now: Date;
	// The query's embedding, when the caller supplied one.
	queryVector?: Float32Array;
};

export type Feature = {
	name: string;
	needsQuery?: boolean;
	// Labour id to a value, in [0, 1] unless the feature says otherwise; null means no data, and a
	// candidate left out takes 0.
	// Read only rows tied to the candidates.
	load(ctx: FeatureContext): Promise<Map<number, number | null>>;
};
