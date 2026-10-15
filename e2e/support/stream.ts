import { origin } from './env.ts';

export type Frame = { id?: string; event?: string; data?: string; comment?: string };

export type EventStream = {
	response: Response;
	frames: () => Frame[];
	events: () => Frame[];
	until: (enough: (frames: Frame[]) => boolean, ms?: number) => Promise<Frame[]>;
	close: () => Promise<void>;
};

function parseFrames(text: string): Frame[] {
	return text
		.split('\n\n')
		.slice(0, -1)
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split('\n')) {
				if (line.startsWith(':')) frame.comment = line.slice(1).trim();
				else {
					const colon = line.indexOf(':');
					const field = line.slice(0, colon) as 'id' | 'event' | 'data';
					frame[field] = line.slice(colon + 1).replace(/^ /, '');
				}
			}
			return frame;
		});
}

const isEvent = (frame: Frame) => frame.event !== undefined;

// Plain fetch, not the request API: that waits for a body that never ends.
export async function openStream(
	headers: Record<string, string>,
	query = ''
): Promise<EventStream> {
	const abort = new AbortController();
	const response = await fetch(`${origin}/api/events${query}`, {
		headers,
		signal: abort.signal,
		redirect: 'manual'
	});
	const decoder = new TextDecoder();
	let text = '';
	let ended = false;
	const waiters = new Set<() => void>();
	const wake = () => waiters.forEach((resolve) => resolve());

	const pump = (async () => {
		if (!response.body) return;
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
				wake();
			}
		} catch {
			// aborted by close()
		} finally {
			ended = true;
			wake();
		}
	})();

	return {
		response,
		frames: () => parseFrames(text),
		events: () => parseFrames(text).filter(isEvent),
		async until(enough, ms = 5000) {
			const deadline = Date.now() + ms;
			while (!enough(parseFrames(text))) {
				const left = deadline - Date.now();
				if (ended || left <= 0) {
					throw new Error(
						`stream ${ended ? 'ended' : 'timed out'}: ${JSON.stringify(parseFrames(text))}`
					);
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					waiters.add(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			return parseFrames(text);
		},
		async close() {
			abort.abort();
			await pump;
		}
	};
}

export const eventCount = (n: number) => (frames: Frame[]) => frames.filter(isEvent).length >= n;
