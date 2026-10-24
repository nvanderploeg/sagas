<script
	lang="ts"
	generics="T extends { id: number; path: string; title: string; descendants: number }"
>
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { resolve } from '$app/paths';
	import type { Placement } from '#lib/server/domain/rank.ts';
	import { placementAt } from '#lib/ui/board.ts';
	import { PointerDrag } from '#lib/ui/drag.svelte.ts';
	import { motion } from '#lib/ui/motion.svelte.ts';

	type Item = T;

	let {
		realmKey,
		items,
		canEdit,
		label,
		onrank
	}: {
		realmKey: string;
		items: Item[];
		canEdit: boolean;
		label: string;
		onrank: (id: number, placement: Placement, order: Item[]) => void;
	} = $props();

	type Drag = { id: number; mode: 'pointer' | 'keyboard'; index: number };
	let drag = $state<Drag | null>(null);
	let start = -1;
	let list = $state<HTMLElement | null>(null);
	let announcement = $state('');

	const others = $derived(items.filter((item) => item.id !== drag?.id));
	const rows = $derived.by(() => {
		const out: { key: number | 'slot'; item: Item | null }[] = others.map((item) => ({
			key: item.id,
			item
		}));
		if (drag) {
			const item = items.find((i) => i.id === drag!.id) ?? null;
			out.splice(Math.min(drag.index, out.length), 0, {
				key: drag.mode === 'pointer' ? 'slot' : drag.id,
				item
			});
		}
		return out;
	});
	const lifted = $derived(drag?.mode === 'pointer' ? items.find((i) => i.id === drag!.id) : null);

	const pointer = new PointerDrag({
		locate(_x, y) {
			if (!list) return null;
			const shown = [...list.querySelectorAll<HTMLElement>('[data-scroll-row]')];
			const index = shown.filter((row) => {
				const r = row.getBoundingClientRect();
				return r.top + r.height / 2 < y;
			}).length;
			return { group: 0, index };
		},
		start(id) {
			start = items.findIndex((i) => i.id === id);
			drag = { id, mode: 'pointer', index: start };
		},
		move(target) {
			if (drag) drag = { ...drag, index: target.index };
		},
		drop() {
			commit();
		},
		cancel() {
			drag = null;
		}
	});

	function commit() {
		const current = drag;
		drag = null;
		if (!current || current.index === start) return;
		const moved = items.find((i) => i.id === current.id);
		if (!moved) return;
		const rest = items.filter((i) => i.id !== current.id);
		const order = [...rest];
		order.splice(current.index, 0, moved);
		announcement = `${moved.title} moved to position ${current.index + 1}.`;
		onrank(current.id, placementAt(rest, current.index), order);
	}

	async function focusHandle(id: number) {
		await tick();
		list?.querySelector<HTMLElement>(`[data-handle="${id}"]`)?.focus();
	}

	function onHandleKey(event: KeyboardEvent, item: Item) {
		if (drag || (event.key !== ' ' && event.key !== 'Enter')) return;
		event.preventDefault();
		// The window handler below would otherwise drop the row on this same key press.
		event.stopPropagation();
		start = items.findIndex((i) => i.id === item.id);
		drag = { id: item.id, mode: 'keyboard', index: start };
		announcement = `Picked up ${item.title}. Arrow keys move it, Space drops it, Escape cancels.`;
	}

	function onLiftedKey(event: KeyboardEvent) {
		if (drag?.mode !== 'keyboard') return;
		const item = items.find((i) => i.id === drag!.id);
		if (!item) return;
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			const index =
				event.key === 'ArrowUp'
					? Math.max(0, drag.index - 1)
					: Math.min(others.length, drag.index + 1);
			drag = { ...drag, index };
			announcement = `Position ${index + 1} of ${items.length}.`;
		} else if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			commit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			drag = null;
			announcement = `${item.title} put back.`;
		} else return;
		focusHandle(item.id);
	}
</script>

<svelte:window onkeydown={onLiftedKey} />

<ol class="divide-y divide-line border-t border-line" bind:this={list} aria-label={label}>
	{#each rows as row (row.key)}
		<li
			data-scroll-row={row.key === 'slot' ? undefined : row.key}
			class:lifted-row={drag?.mode === 'keyboard' && drag.id === row.key}
			animate:flip={{ duration: motion.ms(200) }}
		>
			{#if row.key === 'slot'}
				<div class="slot" style:height="{pointer.lifted?.height ?? 40}px"></div>
			{:else if row.item}
				{@const item = row.item}
				<div class="flex items-center gap-2 px-3 py-2">
					{#if canEdit && items.length > 1}
						<button
							type="button"
							class="handle"
							data-handle={item.id}
							aria-label="Reorder {item.title}"
							onpointerdown={(e) =>
								pointer.begin(e, item.id, (e.currentTarget as HTMLElement).closest('li')!, true)}
							onkeydown={(e) => onHandleKey(e, item)}>⠿</button
						>
					{/if}
					<a
						class="min-w-0 flex-1 truncate font-semibold hover:underline"
						href={resolve('/r/[key]/s/[...path]', { key: realmKey, path: item.path })}
						>{item.title}</a
					>
					{#if item.descendants > 0}
						<span class="text-xs text-muted"
							>{item.descendants} {item.descendants === 1 ? 'page' : 'pages'} under it</span
						>
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ol>

{#if pointer.lifted && lifted}
	<div
		class="ghost"
		aria-hidden="true"
		style:width="{pointer.lifted.width}px"
		style:transform="translate({pointer.lifted.x}px, {pointer.lifted.y}px)"
	>
		{lifted.title}
	</div>
{/if}

<p class="sr-only" aria-live="assertive">{announcement}</p>

<style>
	.handle {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.6rem;
		height: 1.8rem;
		border-radius: 0.4rem;
		color: var(--color-muted);
		touch-action: none;
		cursor: grab;
	}

	.handle:hover {
		background: var(--color-panel-2);
		color: var(--color-ink);
	}

	li {
		background: var(--color-panel);
	}

	.lifted-row {
		position: relative;
		z-index: 1;
		box-shadow: inset 0 0 0 2px var(--color-xp);
	}

	.slot {
		margin: 0.25rem 0.5rem;
		border: 2px dashed color-mix(in srgb, var(--color-xp) 45%, var(--color-line));
		border-radius: 0.6rem;
		background: color-mix(in srgb, var(--color-xp) 8%, transparent);
	}

	.ghost {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 50;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-line);
		border-radius: 0.6rem;
		background: var(--color-panel);
		box-shadow: 0 12px 28px -12px rgb(0 0 0 / 0.45);
		font-weight: 600;
		pointer-events: none;
	}
</style>
