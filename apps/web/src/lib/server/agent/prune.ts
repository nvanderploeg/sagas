import type { Handle } from '../db/client.ts';
import { pruneSurveys } from './survey/index.ts';

export function scheduleAgentPruning(
	db: Handle,
	surveyRetentionMs: number,
	everyMs = 60 * 60 * 1000
): () => void {
	const prune = () => {
		try {
			pruneSurveys(db, surveyRetentionMs);
		} catch (error) {
			console.error('sagas agent layer pruning failed', error);
		}
	};
	prune();
	const timer = setInterval(prune, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
