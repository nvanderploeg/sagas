import type { Handle } from '../db/client.ts';
import { prunePulses } from './sentiment.ts';
import { pruneSurveys } from './survey/index.ts';

export async function scheduleAgentPruning(
	db: Handle,
	surveyRetentionMs: number,
	everyMs = 60 * 60 * 1000
): Promise<() => Promise<void>> {
	const prune = async () => {
		try {
			await pruneSurveys(db, surveyRetentionMs);
		} catch (error) {
			console.error('sagas agent layer pruning failed', error);
		}
		try {
			await prunePulses(db);
		} catch (error) {
			console.error('sagas agent layer pruning failed', error);
		}
	};
	await prune();
	let running: Promise<void> = Promise.resolve();
	const timer = setInterval(() => {
		running = prune();
	}, everyMs);
	timer.unref();
	return async () => {
		clearInterval(timer);
		await running;
	};
}
