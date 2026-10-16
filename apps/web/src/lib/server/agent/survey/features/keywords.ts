import { keywordScoresAmong } from '../../search.ts';
import type { Feature } from './types.ts';

export const keywords: Feature = {
	name: 'keywords',
	needsQuery: true,
	load({ db, candidateIds, query }) {
		return keywordScoresAmong(db, query ?? '', candidateIds);
	}
};
