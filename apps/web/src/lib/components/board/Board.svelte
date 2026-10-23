<script lang="ts">
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { applyToBoard, touchedLabours } from '../../live/apply.ts';
	import type { BoardView, LiveEvent, State, Labour } from '../../live/types.ts';
	import { LiveView } from '../../live/view.svelte.ts';
	import { act } from '../../ui/act.ts';
	import {
		columnOf,
		Drafts,
		encodePlacement,
		matches,
		moveOnBoard,
		NO_FILTER,
		placementAt,
		type Filter
	} from '../../ui/board.ts';
	import { PointerDrag, type Target } from '../../ui/drag.svelte.ts';
	import { lookFor, usersOf } from '../../ui/directory.ts';
	import { cardFlight } from '../../ui/flight.ts';
	import { motion } from '../../ui/motion.svelte.ts';
	import { notices } from '../../ui/notices.svelte.ts';
	import { pan } from '../../ui/pan.ts';
	import { directory, type Person } from '../../ui/people.ts';
	import StatePill from '../StatePill.svelte';
	import LabourCard from './LabourCard.svelte';

	let {
		seq,
		board: loaded,
		me,
		people
	}: { seq: number; board: BoardView; me: Person; people: Person[] } = $props();

	// svelte-ignore state_referenced_locally
	const realmId = loaded.realm.id;
	// svelte-ignore state_referenced_locally
	const live = new LiveView<BoardView>(seq, loaded, applyToBoard(realmId), { onEvent });
	$effect(() => live.load(loaded, seq));

	const board = $derived(live.current);
	const who = $derived(directory(people));
	$effect(() => {
		if (board) lookFor(usersOf(board.labours), who);
	});

	let filter = $state<Filter>({ ...NO_FILTER });
	// The selected Label stays listed after its last Labour loses it, so the filter can be undone.
	const boardLabels = $derived(
		[
			...new Set([
				...(board?.labours.flatMap((t) => t.labels) ?? []),
				...(filter.label ? [filter.label] : [])
			])
		].sort()
	);
	type Drag = { id: number; mode: 'pointer' | 'keyboard'; stateId: number; index: number };
	let drag = $state<Drag | null>(null);
	let origin: { stateId: number; index: number } | null = null;
	let landing = $state<{ id: number; from: DOMRect } | null>(null);
	let announcement = $state('');
	let composing = $state<number | null>(null);
	let draftTitle = $state('');
	let scroller = $state<HTMLElement | null>(null);
	let root = $state<HTMLElement | null>(null);

	const glows = new SvelteMap<number, { actor: Person; n: number }>();
	const bursts = new SvelteMap<number, number>();
	let flashes = 0;

	const { leave, arrive } = cardFlight();

	type Item = { key: number | 'slot'; labour: Labour | null };
	type Column = { state: State; items: Item[]; shown: Labour[]; total: number };

	const sameList = <T,>(a: T[], b: T[], same: (x: T, y: T) => boolean) =>
		a.length === b.length && a.every((x, i) => same(x, b[i]));
	const sameColumn = (a: Column, b: Column) =>
		a.state === b.state &&
		a.total === b.total &&
		sameList(a.shown, b.shown, (x, y) => x === y) &&
		sameList(a.items, b.items, (x, y) => x.key === y.key && x.labour === y.labour);

	// A column that holds the same cards keeps its object, so its list neither re-renders nor
	// measures its cards for the move animation.
	let settled: Column[] = [];
	const columns = $derived.by((): Column[] => {
		if (!board) return [];
		const next = board.realm.states.map((state) => {
			const all = columnOf(board, state.id);
			const shown = all.filter((t) => matches(t, filter) && t.id !== drag?.id);
			const items: Item[] = shown.map((t) => ({ key: t.id, labour: t }));
			if (drag && drag.stateId === state.id) {
				const at = Math.min(drag.index, items.length);
				const dragged = board.labours.find((t) => t.id === drag!.id) ?? null;
				items.splice(
					at,
					0,
					drag.mode === 'pointer'
						? { key: 'slot', labour: dragged }
						: { key: drag.id, labour: dragged }
				);
			}
			const column: Column = { state, items, shown, total: all.length };
			const before = settled.find((c) => c.state.id === state.id);
			return before && sameColumn(before, column) ? before : column;
		});
		if (sameList(next, settled, (a, b) => a === b)) return settled;
		settled = next;
		return next;
	});

	const lifted = $derived(
		drag && board ? (board.labours.find((t) => t.id === drag!.id) ?? null) : null
	);

	$effect(() => {
		if (drag && board && !board.labours.some((t) => t.id === drag!.id)) drag = null;
	});

	let wasClosed: Map<number, boolean> | null = null;
	$effect(() => {
		const labours = board?.labours;
		if (!labours) return;
		const now = new Map(labours.map((t) => [t.id, t.closed]));
		if (wasClosed) {
			for (const [id, closed] of now) {
				if (closed && wasClosed.get(id) === false) celebrate(id);
			}
		}
		wasClosed = now;
	});

	function celebrate(id: number) {
		const n = ++flashes;
		bursts.set(id, n);
		setTimeout(() => bursts.get(id) === n && bursts.delete(id), 1200);
	}

	function onEvent(event: LiveEvent) {
		if (event.actor.id === me.id && !event.actor.via) return;
		for (const id of touchedLabours(event)) {
			const n = ++flashes;
			glows.set(id, { actor: event.actor, n });
			setTimeout(() => glows.get(id)?.n === n && glows.delete(id), 2400);
		}
	}

	const pointer = new PointerDrag({
		locate,
		start(id) {
			const at = indexOf(id);
			if (!at) return;
			origin = at;
			drag = { id, mode: 'pointer', ...at };
		},
		move(target) {
			if (drag) drag = { ...drag, stateId: target.group, index: target.index };
		},
		drop(from) {
			if (!drag) return;
			landing = { id: drag.id, from };
			commit();
			setTimeout(() => (landing = null), 400);
		},
		cancel() {
			drag = null;
		},
		scroller: () => scroller,
		list: (stateId) => listOf(root?.querySelector(`[data-column="${stateId}"]`) ?? null)
	});

	const listOf = (el: Element | null) =>
		el?.closest('[data-column]')?.querySelector<HTMLElement>('[data-list]') ?? null;

	// The card a pointer is carrying leaves and rejoins lists at once: the slot stands in for it.
	// A draft card gives way to its created Labour at once, so the two never show together.
	const jumps = (key: number | 'slot') =>
		(typeof key === 'number' && key < 0) || (drag?.mode === 'pointer' && drag.id === key);

	function indexOf(id: number): { stateId: number; index: number } | null {
		const labour = board?.labours.find((t) => t.id === id);
		const column = columns.find((c) => c.state.id === labour?.stateId);
		if (!labour || !column) return null;
		return { stateId: labour.stateId, index: column.shown.findIndex((t) => t.id === id) };
	}

	function locate(x: number, y: number): Target | null {
		if (!root) return null;
		const lanes = [...root.querySelectorAll<HTMLElement>('[data-column]')];
		let best: HTMLElement | null = null;
		let distance = Infinity;
		for (const lane of lanes) {
			const r = lane.getBoundingClientRect();
			const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
			if (d < distance) {
				distance = d;
				best = lane;
			}
		}
		if (!best) return null;
		const cards = [...best.querySelectorAll<HTMLElement>('[data-card]')];
		const index = cards.filter((card) => {
			const r = card.getBoundingClientRect();
			return r.top + r.height / 2 < y;
		}).length;
		return { group: Number(best.dataset.column), index };
	}

	async function commit() {
		const current = drag;
		const start = origin;
		if (!current || !board) {
			drag = null;
			return;
		}
		const column = columns.find((c) => c.state.id === current.stateId);
		const shown = column?.shown ?? [];
		const placement = placementAt(shown, current.index);
		const labour = board.labours.find((t) => t.id === current.id);
		const state = board.realm.states.find((s) => s.id === current.stateId);
		let next: BoardView | null;
		try {
			next = moveOnBoard(board, current.id, current.stateId, placement);
		} catch {
			next = null;
		}
		drag = null;
		origin = null;
		if (!next || !labour || !state) return;
		if (start && start.stateId === current.stateId && start.index === current.index) return;
		announcement = `${labour.key} moved to ${state.label}, position ${current.index + 1}.`;
		try {
			await live.mutate(
				(view) => moveOnBoard(view, current.id, current.stateId, placement) ?? view,
				() =>
					act('move', {
						labourId: current.id,
						stateId: current.stateId,
						placement: encodePlacement(placement)
					})
			);
		} catch (error) {
			notices.error(error);
		}
	}

	async function focusCard(id: number) {
		await tick();
		root?.querySelector<HTMLElement>(`[data-card-link="${id}"]`)?.focus();
	}

	function onCardKey(event: KeyboardEvent, labour: Labour) {
		if (drag || event.key !== ' ') return;
		event.preventDefault();
		// The window handler below would otherwise drop the card on this same key press.
		event.stopPropagation();
		const at = indexOf(labour.id);
		if (!at) return;
		origin = at;
		drag = { id: labour.id, mode: 'keyboard', ...at };
		announcement = `Picked up ${labour.key}. Arrow keys move it, Space drops it, Escape cancels.`;
	}

	// Listens on the window: the lifted card is a new element after each move between columns,
	// and a key can land before focus follows it.
	function onLiftedKey(event: KeyboardEvent) {
		if (drag?.mode !== 'keyboard') return;
		const labour = board?.labours.find((t) => t.id === drag!.id);
		if (!labour) return;
		const states = board?.realm.states ?? [];
		const lane = states.findIndex((s) => s.id === drag!.stateId);
		const length = (stateId: number) =>
			columns.find((c) => c.state.id === stateId)?.shown.length ?? 0;
		switch (event.key) {
			case 'ArrowUp':
				drag = { ...drag, index: Math.max(0, drag.index - 1) };
				break;
			case 'ArrowDown':
				drag = { ...drag, index: Math.min(length(drag.stateId), drag.index + 1) };
				break;
			case 'ArrowLeft':
			case 'ArrowRight': {
				const to = states[lane + (event.key === 'ArrowLeft' ? -1 : 1)];
				if (!to) break;
				drag = { ...drag, stateId: to.id, index: Math.min(drag.index, length(to.id)) };
				break;
			}
			case ' ':
			case 'Enter':
				event.preventDefault();
				commit();
				focusCard(labour.id);
				return;
			case 'Escape':
				event.preventDefault();
				drag = null;
				origin = null;
				announcement = `${labour.key} put back.`;
				focusCard(labour.id);
				return;
			default:
				return;
		}
		event.preventDefault();
		const state = states.find((s) => s.id === drag!.stateId);
		announcement = `${state?.label}, position ${drag.index + 1}.`;
		focusCard(labour.id);
	}

	const drafts = new Drafts();

	async function quickCreate(state: State) {
		const title = draftTitle.trim();
		if (!title || !board) return;
		draftTitle = '';
		const known = new Set(board.labours.map((t) => t.id));
		const now = new Date().toISOString();
		const draft: Labour = {
			id: -++flashes,
			realmId,
			number: 0,
			title,
			description: '',
			ownerId: me.id,
			assigneeId: null,
			stateId: state.id,
			substateId: state.substates.length > 0 ? state.defaultSubstateId : null,
			parentId: null,
			rank: '',
			labels: [],
			createdAt: now,
			updatedAt: now,
			key: '',
			closed: state.isClosed
		};
		try {
			await live.mutate(drafts.add(draft, known), async () => {
				const done = await act('create', { stateId: state.id, title });
				drafts.answer(draft.id, Number(done.id));
				return done;
			});
		} catch (error) {
			drafts.forget(draft.id);
			notices.error(error);
		}
	}

	$effect(() => {
		const key = board?.realm.key;
		if (key && resolve('/r/[key]', { key }) !== location.pathname) {
			goto(resolve('/r/[key]', { key }), { replace: true, shallow: true });
		}
	});

	$effect(() => {
		if (live.ended) {
			notices.show('This Realm was deleted.');
			goto(resolve('/'));
		}
	});
</script>

<svelte:window onkeydown={onLiftedKey} />

{#if board}
	<div class="page">
		<header class="head">
			<div class="min-w-0">
				<h1>{board.realm.name}</h1>
				<p class="sub">
					<span class="key">{board.realm.key}</span>
					<span aria-hidden="true">·</span>
					{board.labours.length}
					{board.labours.length === 1 ? 'Labour' : 'Labours'}
				</p>
			</div>
			<a class="btn" href={resolve('/r/[key]/settings', { key: board.realm.key })}>Settings</a>
		</header>

		<div class="tools" role="group" aria-label="Filter">
			<label class="flex items-center gap-2">
				<span class="label">Owner</span>
				<select
					class="field"
					value={filter.owner ?? ''}
					onchange={(e) => {
						const v = e.currentTarget.value;
						filter = { ...filter, owner: v === '' ? null : Number(v) };
					}}
				>
					<option value="">Anyone</option>
					{#each people as person (person.id)}
						<option value={person.id}>{person.displayName}</option>
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-2">
				<span class="label">Assignee</span>
				<select
					class="field"
					value={filter.assignee ?? ''}
					onchange={(e) => {
						const v = e.currentTarget.value;
						filter = {
							...filter,
							assignee: v === '' ? null : v === 'none' ? 'none' : Number(v)
						};
					}}
				>
					<option value="">Anyone</option>
					<option value="none">Unassigned</option>
					{#each people as person (person.id)}
						<option value={person.id}>{person.displayName}</option>
					{/each}
				</select>
			</label>
			{#if boardLabels.length > 0}
				<label class="flex items-center gap-2">
					<span class="label">Label</span>
					<select
						class="field"
						value={filter.label ?? ''}
						onchange={(e) => {
							const v = e.currentTarget.value;
							filter = { ...filter, label: v === '' ? null : v };
						}}
					>
						<option value="">Any</option>
						{#each boardLabels as label (label)}
							<option value={label}>{label}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if filter.owner !== null || filter.assignee !== null || filter.label !== null}
				<button type="button" class="btn btn-quiet" onclick={() => (filter = { ...NO_FILTER })}
					>Clear filters</button
				>
			{/if}
			<p id="board-help" class="hint">
				Drag cards to move them. Keyboard: focus a card, Space picks it up, arrows move it, Space
				drops it.
			</p>
		</div>

		<div class="scroller" bind:this={scroller} {@attach pan(listOf)}>
			<div class="columns" bind:this={root}>
				{#each columns as column (column.state.id)}
					{@const composingHere = composing === column.state.id}
					<section
						class="lane"
						class:target={drag?.stateId === column.state.id}
						data-column={column.state.id}
						data-testid="column"
						data-state={column.state.label}
						style:--sc={column.state.color}
						aria-labelledby="lane-{column.state.id}"
					>
						<header class="lane-head">
							<h2 id="lane-{column.state.id}">
								<StatePill def={column.state} />
							</h2>
							<span class="count" aria-label="{column.total} Labours">{column.total}</span>
							<button
								type="button"
								class="add"
								aria-label="Add a Labour to {column.state.label}"
								aria-expanded={composingHere}
								onclick={() => {
									composing = composingHere ? null : column.state.id;
									draftTitle = '';
								}}>+</button
							>
						</header>
						<ol class="cards" data-list aria-label="{column.state.label} Labours">
							{#each column.items as item (item.key)}
								{@const t = item.labour}
								<li
									data-card={item.key === 'slot' ? undefined : item.key}
									animate:flip={{ duration: motion.ms(drag?.mode === 'pointer' ? 160 : 260) }}
									in:arrive={{
										key: item.key,
										instant: item.key === 'slot' || jumps(item.key),
										from: landing?.id === item.key ? landing.from : null
									}}
									out:leave={{
										key: item.key,
										instant: item.key === 'slot' || jumps(item.key)
									}}
								>
									{#if item.key === 'slot'}
										<div
											class="drop"
											style:height="{pointer.lifted?.height ?? 64}px"
											aria-hidden="true"
										></div>
									{:else if t}
										{@const state = board.realm.states.find((s) => s.id === t.stateId)}
										<LabourCard
											labour={t}
											{state}
											substate={state?.substates.find((s) => s.id === t.substateId)}
											assignee={t.assigneeId === null ? null : who.get(t.assigneeId)}
											glow={glows.get(t.id) ?? null}
											burst={bursts.get(t.id) ?? 0}
											lifted={drag?.id === t.id}
											describedby="board-help"
											onpointerdown={(e) => {
												const el = (e.currentTarget as HTMLElement).parentElement!;
												pointer.begin(e, t.id, el);
											}}
											onhandledown={(e) => {
												const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('.card')!;
												pointer.begin(e, t.id, el, true);
											}}
											onkeydown={(e) => onCardKey(e, t)}
										/>
									{/if}
								</li>
							{/each}
						</ol>
						{#if composingHere}
							<form
								class="compose"
								onsubmit={(e) => {
									e.preventDefault();
									quickCreate(column.state);
								}}
							>
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="field w-full"
									aria-label="New Labour title in {column.state.label}"
									placeholder="Title, then Enter"
									maxlength="200"
									autofocus
									bind:value={draftTitle}
									onkeydown={(e) => {
										if (e.key === 'Escape') composing = null;
									}}
								/>
								<div class="flex gap-2">
									<button type="submit" class="btn btn-primary" disabled={!draftTitle.trim()}
										>Add Labour</button
									>
									<button type="button" class="btn btn-quiet" onclick={() => (composing = null)}
										>Done</button
									>
								</div>
							</form>
						{/if}
					</section>
				{/each}
			</div>
		</div>
	</div>

	{#if pointer.lifted && lifted}
		{@const state = board.realm.states.find((s) => s.id === (drag?.stateId ?? lifted.stateId))}
		<div
			class="floating"
			style:width="{pointer.lifted.width}px"
			style:transform="translate({pointer.lifted.x}px, {pointer.lifted.y}px) rotate(2deg)"
			data-testid="floating-card"
		>
			<LabourCard
				labour={lifted}
				{state}
				substate={state?.substates.find((s) => s.id === lifted.substateId)}
				assignee={lifted.assigneeId === null ? null : who.get(lifted.assigneeId)}
				floating
			/>
		</div>
	{/if}

	<p class="sr-only" aria-live="assertive">{announcement}</p>
{/if}

<style>
	.page {
		display: grid;
		gap: 1rem;
		padding: 0.5rem 1rem 3rem;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		font-size: clamp(1.7rem, 5vw, 2.6rem);
		font-weight: 750;
		letter-spacing: -0.025em;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}

	.sub {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.35rem;
		color: var(--color-muted);
		font-size: 0.9rem;
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 1rem;
	}

	.hint {
		margin-left: auto;
		color: var(--color-muted);
		font-size: 0.8rem;
	}

	.scroller {
		--lane-max: max(20rem, calc(100dvh - 15rem));
		margin-inline: -1rem;
		padding: 0.25rem 1rem 1rem;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		cursor: grab;
	}

	.columns {
		display: flex;
		align-items: flex-start;
		gap: 0.9rem;
		width: max-content;
		min-width: 100%;
	}

	.lane {
		display: flex;
		flex: 0 0 18rem;
		flex-direction: column;
		gap: 0.6rem;
		min-height: 12rem;
		max-height: var(--lane-max);
		padding: 0.6rem;
		border: 1px solid color-mix(in srgb, var(--sc) 18%, var(--color-line));
		border-radius: 1.1rem;
		background: color-mix(in srgb, var(--sc) 6%, var(--color-panel-2));
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.lane.target {
		border-color: color-mix(in srgb, var(--sc) 55%, var(--color-line));
		background: color-mix(in srgb, var(--sc) 11%, var(--color-panel-2));
	}

	.lane-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.1rem 0.15rem;
	}

	.lane-head h2 {
		min-width: 0;
		margin: 0;
	}

	.count {
		color: var(--color-muted);
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.add {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		margin-left: auto;
		border-radius: 0.5rem;
		color: var(--color-muted);
		font-size: 1.15rem;
		line-height: 1;
		cursor: pointer;
	}

	.add:hover,
	.add[aria-expanded='true'] {
		background: var(--color-panel);
		color: var(--color-ink);
	}

	.cards {
		display: grid;
		flex: 1 1 auto;
		align-content: start;
		gap: 0.5rem;
		min-height: 2.5rem;
		/* Room inside the scroll box for focus rings and glows. */
		margin: -0.3rem;
		padding: 0.3rem;
		overflow-y: auto;
		overscroll-behavior-y: contain;
		list-style: none;
	}

	.drop {
		border: 2px dashed color-mix(in srgb, var(--sc) 55%, var(--color-line));
		border-radius: 0.8rem;
		background: color-mix(in srgb, var(--sc) 10%, transparent);
	}

	.compose {
		display: grid;
		gap: 0.5rem;
	}

	.floating {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 50;
		pointer-events: none;
		transform-origin: 30% 20%;
	}

	:global(html.panning) {
		cursor: grabbing;
		user-select: none;
	}

	:global(html.dragging) {
		cursor: grabbing;
		user-select: none;
	}
</style>
