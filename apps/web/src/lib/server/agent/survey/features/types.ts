import type { Handle } from '../../../db/client.ts';
import type { Candidate } from '../candidates.ts';

export type FeatureContext = {
	db: Handle;
	// In board order.
	candidates: Candidate[];
	// The candidates' ids as one JSON array; read it through `json_each`, never as bound variables.
	candidateIds: string;
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
	// Labour id to a value in [0, 1]; null means no data, and a candidate left out takes 0.
	// Read only rows tied to the candidates.
	load(ctx: FeatureContext): Map<number, number | null>;
};
