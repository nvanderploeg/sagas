import { onMount } from 'svelte';
import { refreshAll } from '$app/navigation';
import type { Apply } from './apply.ts';
import { LiveCore } from './core.ts';
import { stream } from './stream.svelte.ts';
import type { LiveEvent } from './types.ts';

let reloading: Promise<void> | null = null;

// One refresh serves every view that asks while it runs.
function reloadAll(): void {
	reloading ??= refreshAll().finally(() => (reloading = null));
}

export type LiveViewOptions<T> = {
	onEvent?: (event: LiveEvent, before: T, after: T) => void;
};

// Construct during component init: it attaches to the Stream on mount and detaches on destroy.
export class LiveView<T> {
	current = $state.raw<T | null>(null);
	#core: LiveCore<T>;
	#loaded: T;

	constructor(seq: number, value: T, apply: Apply<T>, options: LiveViewOptions<T> = {}) {
		this.#loaded = value;
		this.#core = new LiveCore<T>({
			seq,
			value,
			apply,
			onChange: () => (this.current = this.#core.value),
			onReload: reloadAll,
			onEvent: options.onEvent
		});
		this.current = this.#core.value;
		onMount(() => this.#core.connect(stream));
	}

	get ended(): boolean {
		return this.current === null;
	}

	// Takes a page's load data; the same data twice is a no-op.
	load(value: T, seq: number): void {
		if (value === this.#loaded) return;
		this.#loaded = value;
		this.#core.load(value, seq);
	}

	mutate<R extends { seq: number }>(patch: (view: T) => T, run: () => Promise<R>): Promise<R> {
		return this.#core.mutate(patch, run);
	}
}
