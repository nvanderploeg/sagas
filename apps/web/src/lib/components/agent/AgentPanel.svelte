<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { advanced } from '#lib/ui/advanced.svelte.ts';
	import { stamp } from '#lib/ui/time.ts';

	let {
		url,
		isEmpty,
		body,
		onload
	}: {
		url: string;
		isEmpty: (data: T) => boolean;
		body: Snippet<[T]>;
		onload?: (data: T) => void;
	} = $props();

	let data = $state.raw<T | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let updatedAt = $state<string | null>(null);
	let loaded = '';
	let latest = 0;

	const status = $derived(
		failed
			? 'The agent layer could not be loaded.'
			: loading
				? 'Loading the agent layer…'
				: updatedAt === null
					? ''
					: `Updated ${stamp(updatedAt)}`
	);

	async function load() {
		const mine = ++latest;
		if (loaded !== url) {
			data = null;
			updatedAt = null;
		}
		loaded = url;
		loading = true;
		failed = false;
		try {
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(String(response.status));
			const next = (await response.json()) as T;
			if (mine === latest) {
				data = next;
				updatedAt = new Date().toISOString();
				onload?.(next);
			}
		} catch {
			if (mine === latest) failed = true;
		} finally {
			if (mine === latest) loading = false;
		}
	}

	// Track only `url` and the switch: anything else read here refetches on every change.
	$effect(() => {
		if (advanced.on) void load();
		else {
			latest++;
			data = null;
			updatedAt = null;
			loading = false;
			failed = false;
			loaded = '';
		}
	});
</script>

{#if advanced.on}
	<!-- Wrap anywhere and let grid items shrink: an unbroken agent-written token would widen the page. -->
	<section
		class="panel grid min-w-0 gap-4 p-5 [overflow-wrap:anywhere] *:min-w-0 [&_*]:min-w-0 [&_.key]:whitespace-normal [&_pre]:max-w-full [&_pre]:overflow-x-auto"
		aria-labelledby="agent-heading"
		data-testid="agent-layer"
	>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<h2 id="agent-heading" class="font-bold tracking-tight">Agent layer</h2>
			<p
				aria-live="polite"
				class="flex-1 text-xs {failed ? 'text-danger' : 'text-muted'}"
				data-testid="agent-status"
			>
				{status}
			</p>
			<button class="btn btn-quiet" type="button" disabled={loading} onclick={load}>Refresh</button>
		</div>
		{#if data !== null}
			<div class="grid gap-5 *:min-w-0">
				{#if isEmpty(data)}
					<p class="text-sm text-muted">No agent layer yet.</p>
				{:else}
					{@render body(data)}
				{/if}
			</div>
		{/if}
	</section>
{/if}
