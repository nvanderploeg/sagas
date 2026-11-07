// Import only a type from dispatcher.ts: store.ts imports this module, and dispatcher.ts imports
// store.ts.
import type { Dispatcher } from './dispatcher.ts';

let current: Dispatcher | null = null;

export function setDispatcher(dispatcher: Dispatcher | null): void {
	if (current !== dispatcher) current?.stop();
	current = dispatcher;
}

export async function nudgeWebhook(id: number): Promise<void> {
	await current?.nudge(id);
}
