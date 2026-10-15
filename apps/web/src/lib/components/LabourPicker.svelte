<script lang="ts" module>
	import type { Labour } from '../live/types.ts';

	export type Match = Labour & { childCount: number };
</script>

<script lang="ts">
	let {
		label,
		placeholder = 'Labour key or title',
		exclude = [],
		onpick
	}: {
		label: string;
		placeholder?: string;
		exclude?: number[];
		onpick: (labour: Match) => void;
	} = $props();

	const id = $props.id();
	let query = $state('');
	let results = $state<Match[]>([]);
	let active = $state(0);
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let asked = 0;

	const shown = $derived(results.filter((t) => !exclude.includes(t.id)));

	function search(value: string) {
		clearTimeout(timer);
		if (value.trim() === '') {
			results = [];
			open = false;
			return;
		}
		timer = setTimeout(async () => {
			const ask = ++asked;
			const response = await fetch(`/search?q=${encodeURIComponent(value)}`);
			if (ask !== asked || !response.ok) return;
			results = (await response.json()) as Match[];
			active = 0;
			open = true;
		}, 150);
	}

	function pick(labour: Match) {
		onpick(labour);
		query = '';
		results = [];
		open = false;
	}

	function onkeydown(event: KeyboardEvent) {
		if (!open || shown.length === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = (active + 1) % shown.length;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = (active - 1 + shown.length) % shown.length;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			pick(shown[active]);
		} else if (event.key === 'Escape') {
			open = false;
		}
	}
</script>

<div class="picker">
	<label class="label" for="{id}-input">{label}</label>
	<input
		id="{id}-input"
		class="field w-full"
		type="search"
		autocomplete="off"
		role="combobox"
		aria-expanded={open && shown.length > 0}
		aria-controls="{id}-list"
		aria-activedescendant={open && shown[active] ? `${id}-${shown[active].id}` : undefined}
		{placeholder}
		bind:value={query}
		oninput={() => search(query)}
		{onkeydown}
		onblur={() => setTimeout(() => (open = false), 150)}
	/>
	{#if open}
		<ul id="{id}-list" role="listbox" class="list" aria-label="{label} results">
			{#each shown as labour, i (labour.id)}
				<!-- The combobox input takes the keys for these options. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="{id}-{labour.id}"
					role="option"
					aria-selected={i === active}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => pick(labour)}
				>
					<span class="key">{labour.key}</span>
					<span class="title">{labour.title}</span>
					{#if labour.childCount > 0}
						<span class="kids"
							>{labour.childCount} {labour.childCount === 1 ? 'Child' : 'Children'}</span
						>
					{/if}
				</li>
			{:else}
				<li class="none">No Labour matches “{query}”.</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker {
		position: relative;
		display: grid;
		gap: 0.3rem;
	}

	.list {
		position: absolute;
		top: 100%;
		right: 0;
		left: 0;
		z-index: 30;
		max-height: 18rem;
		margin-top: 0.25rem;
		overflow-y: auto;
		padding: 0.25rem;
		border: 1px solid var(--color-line);
		border-radius: 0.75rem;
		background: var(--color-panel);
		box-shadow: 0 16px 40px -20px rgb(0 0 0 / 0.5);
	}

	li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.4rem 0.6rem;
		border-radius: 0.5rem;
		font-size: 0.9rem;
		cursor: pointer;
	}

	li[aria-selected='true'] {
		background: var(--color-panel-2);
	}

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.kids {
		color: var(--color-muted);
		font-size: 0.78rem;
		white-space: nowrap;
	}

	.none {
		color: var(--color-muted);
		cursor: default;
	}
</style>
