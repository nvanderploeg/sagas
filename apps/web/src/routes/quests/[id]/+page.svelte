<script lang="ts">
	import { tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { SvelteMap } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Avatar from '#lib/components/Avatar.svelte';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import LabourPicker, { type Match } from '#lib/components/LabourPicker.svelte';
	import LabourRow from '#lib/components/LabourRow.svelte';
	import XpBar from '#lib/components/XpBar.svelte';
	import { applyToQuestPage } from '#lib/live/apply.ts';
	import type { Quest, QuestPageView, Labour } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { act, type Fields } from '#lib/ui/act.ts';
	import { encodePlacement, placementAt } from '#lib/ui/board.ts';
	import { lookFor, usersOf } from '#lib/ui/directory.ts';
	import { PointerDrag } from '#lib/ui/drag.svelte.ts';
	import { cardFlight } from '#lib/ui/flight.ts';
	import { motion } from '#lib/ui/motion.svelte.ts';
	import { notices } from '#lib/ui/notices.svelte.ts';
	import { directory } from '#lib/ui/people.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// svelte-ignore state_referenced_locally
	const live = new LiveView<QuestPageView>(data.seq, data.page, applyToQuestPage);
	$effect(() => live.load(data.page, data.seq));

	const view = $derived(live.current);
	const people = $derived(directory(data.people));
	const errors = new SvelteMap<string, string>();

	$effect(() => {
		if (view) lookFor([view.quest.ownerId, ...usersOf(view.quest.labours)], people);
	});

	// Completion is celebrated only when a member's closing completes the Quest; removing the last
	// open member or adding a Closed one completes it quietly.
	let celebrations = $state(0);
	let celebrated = 0;
	let wasClosed: Map<number, boolean> | null = null;
	$effect(() => {
		const labours = view?.quest.labours;
		if (!labours) return;
		const now = new Map(labours.map((t) => [t.id, t.closed]));
		const before = wasClosed;
		wasClosed = now;
		if (!before || labours.length === 0 || !labours.every((t) => t.closed)) return;
		if ([...before.values()].every(Boolean) && before.size > 0) return;
		if (labours.some((t) => before.get(t.id) === false)) celebrations = ++celebrated;
	});

	$effect(() => {
		if (live.ended) {
			notices.show('This Quest was deleted.');
			goto(resolve('/quests'));
		}
	});

	async function save(scope: string, name: string, fields: Fields, patch: (q: Quest) => Quest) {
		errors.delete(scope);
		try {
			await live.mutate(
				(v) => ({ ...v, quest: patch(v.quest) }),
				() => act(name, fields)
			);
		} catch (error) {
			errors.set(scope, (error as Error).message);
		}
	}

	const progressOf = (labours: Labour[]) => ({
		closed: labours.filter((t) => t.closed).length,
		total: labours.length
	});

	let editingName = $state(false);
	let nameDraft = $state('');
	let editingBody = $state(false);
	let bodyDraft = $state('');
	let renameButton = $state<HTMLButtonElement | null>(null);
	let editBodyButton = $state<HTMLButtonElement | null>(null);
	let bodyField = $state<HTMLTextAreaElement | null>(null);

	// The control pressed goes away with the editor; focus moves to the one that takes its place.
	async function focusSoon(target: () => HTMLElement | null) {
		await tick();
		target()?.focus();
	}

	function closeName() {
		editingName = false;
		focusSoon(() => renameButton);
	}

	function closeBody() {
		editingBody = false;
		focusSoon(() => editBodyButton);
	}

	let staged = $state<Match | null>(null);
	let withChildren = $state(false);

	async function addStaged() {
		const labour = staged;
		if (!labour) return;
		const children = withChildren && labour.childCount > 0;
		staged = null;
		withChildren = false;
		await save('add', 'add', { labourId: labour.id, children }, (q) => {
			if (q.labours.some((t) => t.id === labour.id)) return q;
			const labours = [...q.labours, labour];
			return { ...q, labours, progress: progressOf(labours) };
		});
	}

	function remove(labour: Labour) {
		save('members', 'remove', { labourId: labour.id }, (q) => {
			const labours = q.labours.filter((t) => t.id !== labour.id);
			return { ...q, labours, progress: progressOf(labours) };
		});
	}

	type Drag = { id: number; mode: 'pointer' | 'keyboard'; index: number };
	let drag = $state<Drag | null>(null);
	let start = -1;
	let landing = $state<{ id: number; from: DOMRect } | null>(null);
	let list = $state<HTMLElement | null>(null);
	let announcement = $state('');
	const { leave, arrive } = cardFlight();

	const members = $derived(view?.quest.labours ?? []);
	const others = $derived(members.filter((t) => t.id !== drag?.id));
	const items = $derived.by(() => {
		const rows: { key: number | 'slot'; labour: Labour | null }[] = others.map((t) => ({
			key: t.id,
			labour: t
		}));
		if (drag) {
			const labour = members.find((t) => t.id === drag!.id) ?? null;
			rows.splice(Math.min(drag.index, rows.length), 0, {
				key: drag.mode === 'pointer' ? 'slot' : drag.id,
				labour
			});
		}
		return rows;
	});
	const jumps = (key: number | 'slot') => drag?.mode === 'pointer' && drag.id === key;

	const pointer = new PointerDrag({
		locate(_x, y) {
			if (!list) return null;
			const rows = [...list.querySelectorAll<HTMLElement>('[data-member]')];
			const index = rows.filter((row) => {
				const r = row.getBoundingClientRect();
				return r.top + r.height / 2 < y;
			}).length;
			return { group: 0, index };
		},
		start(id) {
			start = members.findIndex((t) => t.id === id);
			drag = { id, mode: 'pointer', index: start };
		},
		move(target) {
			if (drag) drag = { ...drag, index: target.index };
		},
		drop(from) {
			if (!drag) return;
			landing = { id: drag.id, from };
			commit();
			setTimeout(() => (landing = null), 400);
		},
		cancel() {
			drag = null;
		}
	});

	function commit() {
		const current = drag;
		drag = null;
		if (!current || !view || current.index === start) return;
		const placement = placementAt(others, current.index);
		const moved = view.quest.labours.find((t) => t.id === current.id);
		announcement = `${moved?.key} moved to position ${current.index + 1}.`;
		const order = [...others];
		if (moved) order.splice(current.index, 0, moved);
		save(
			'members',
			'rank',
			{ labourId: current.id, placement: encodePlacement(placement) },
			(q) => {
				const ids = order.map((t) => t.id);
				const labours = [...q.labours].sort((a, b) => {
					const ia = ids.indexOf(a.id);
					const ib = ids.indexOf(b.id);
					return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
				});
				return { ...q, labours };
			}
		);
	}

	async function focusHandle(id: number) {
		await tick();
		list?.querySelector<HTMLElement>(`[data-handle="${id}"]`)?.focus();
	}

	function onHandleKey(event: KeyboardEvent, labour: Labour) {
		if (drag || (event.key !== ' ' && event.key !== 'Enter')) return;
		event.preventDefault();
		// The window handler below would otherwise drop the row on this same key press.
		event.stopPropagation();
		start = members.findIndex((t) => t.id === labour.id);
		drag = { id: labour.id, mode: 'keyboard', index: start };
		announcement = `Picked up ${labour.key}. Arrow keys move it, Space drops it, Escape cancels.`;
	}

	function onLiftedKey(event: KeyboardEvent) {
		if (drag?.mode !== 'keyboard') return;
		const labour = members.find((t) => t.id === drag!.id);
		if (!labour) return;
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			const index =
				event.key === 'ArrowUp'
					? Math.max(0, drag.index - 1)
					: Math.min(others.length, drag.index + 1);
			drag = { ...drag, index };
			announcement = `Position ${index + 1} of ${members.length}.`;
		} else if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			commit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			drag = null;
			announcement = `${labour.key} put back.`;
		} else return;
		focusHandle(labour.id);
	}

	const owner = $derived(view ? people.get(view.quest.ownerId) : undefined);
</script>

<svelte:head>
	<title>{view?.quest.name ?? 'Quest'} · sagas</title>
</svelte:head>

<svelte:window onkeydown={onLiftedKey} />

{#if view}
	{@const quest = view.quest}
	<main class="mx-auto grid max-w-6xl gap-6 px-4 pt-2 pb-16">
		<a class="w-fit text-sm text-muted hover:text-ink" href={resolve('/quests')}>← Quests</a>

		<header class="panel grid gap-5 p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				{#if editingName}
					<form
						class="flex min-w-0 flex-1 flex-wrap gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							const name = nameDraft.trim();
							if (!name) return;
							closeName();
							save('name', 'update', { name }, (q) => ({ ...q, name }));
						}}
					>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="field min-w-0 flex-1 text-xl font-bold"
							aria-label="Quest name"
							maxlength="120"
							required
							autofocus
							bind:value={nameDraft}
							onkeydown={(e) => e.key === 'Escape' && closeName()}
						/>
						<button class="btn btn-primary" type="submit">Save name</button>
						<button class="btn btn-quiet" type="button" onclick={closeName}>Cancel</button>
					</form>
				{:else}
					<div class="flex min-w-0 flex-1 flex-wrap items-start gap-2">
						<h1 class="min-w-0 text-3xl font-extrabold tracking-tight [overflow-wrap:anywhere]">
							{quest.name}
						</h1>
						<button
							class="btn btn-quiet"
							type="button"
							bind:this={renameButton}
							onclick={() => {
								nameDraft = quest.name;
								editingName = true;
							}}>Rename</button
						>
					</div>
				{/if}
				<div class="flex items-center gap-2">
					{#if owner}<Avatar person={owner} size="sm" />{/if}
					<label class="sr-only" for="quest-owner">Owner</label>
					<select
						id="quest-owner"
						class="field"
						value={quest.ownerId}
						onchange={(e) => {
							const ownerId = Number(e.currentTarget.value);
							save('owner', 'update', { ownerId }, (q) => ({ ...q, ownerId }));
						}}
					>
						{#if !owner}<option value={quest.ownerId}>Loading…</option>{/if}
						{#each data.people as person (person.id)}
							<option value={person.id}>{person.displayName}</option>
						{/each}
					</select>
				</div>
			</div>
			{#each ['name', 'owner'] as scope (scope)}
				{#if errors.get(scope)}<p role="alert" class="error">{errors.get(scope)}</p>{/if}
			{/each}
			<div class="pt-2">
				<XpBar
					closed={quest.progress.closed}
					total={quest.progress.total}
					size="lg"
					celebrate={celebrations}
				/>
			</div>
		</header>

		<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
			<section class="panel overflow-hidden" aria-labelledby="members-heading">
				<div class="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
					<h2 id="members-heading" class="font-bold tracking-tight">Labours</h2>
					<p id="members-help" class="text-xs text-muted">
						Drag ⠿ to reorder, or focus it and press Space, then arrows.
					</p>
				</div>
				{#if members.length === 0}
					<p class="px-5 pb-5 text-sm text-muted">
						No Labours yet. Add them from any Realm with the search on the right.
					</p>
				{:else}
					<ol
						class="divide-y divide-line border-t border-line"
						bind:this={list}
						data-testid="members"
					>
						{#each items as item (item.key)}
							<li
								data-member={item.key === 'slot' ? undefined : item.key}
								class:lifted={drag?.mode === 'keyboard' && drag.id === item.key}
								animate:flip={{ duration: motion.ms(200) }}
								in:arrive={{
									key: item.key,
									instant: item.key === 'slot' || jumps(item.key),
									from: landing?.id === item.key ? landing.from : null
								}}
								out:leave={{ key: item.key, instant: item.key === 'slot' || jumps(item.key) }}
							>
								{#if item.key === 'slot'}
									<div class="slot" style:height="{pointer.lifted?.height ?? 44}px"></div>
								{:else if item.labour}
									{@const labour = item.labour}
									<LabourRow {labour} realms={view.realms} {people}>
										{#snippet lead()}
											<button
												type="button"
												class="handle"
												data-handle={labour.id}
												aria-label="Reorder {labour.key}"
												aria-describedby="members-help"
												onpointerdown={(e) =>
													pointer.begin(
														e,
														labour.id,
														(e.currentTarget as HTMLElement).closest('li')!,
														true
													)}
												onkeydown={(e) => onHandleKey(e, labour)}>⠿</button
											>
										{/snippet}
										{#snippet actions()}
											<button
												type="button"
												class="btn btn-quiet"
												aria-label="Remove {labour.key} from the Quest"
												onclick={() => remove(labour)}>Remove</button
											>
										{/snippet}
									</LabourRow>
								{/if}
							</li>
						{/each}
					</ol>
				{/if}
				{#if errors.get('members')}<p role="alert" class="error px-5 pb-4">
						{errors.get('members')}
					</p>{/if}
			</section>

			<aside class="grid gap-6">
				<section class="panel grid gap-3 p-5" aria-labelledby="add-heading">
					<h2 id="add-heading" class="font-bold tracking-tight">Add a Labour</h2>
					<LabourPicker
						label="Find a Labour"
						exclude={members.map((t) => t.id)}
						onpick={(labour) => {
							staged = labour;
							withChildren = false;
						}}
					/>
					{#if staged}
						<div class="grid gap-2 rounded-lg border border-line p-3" data-testid="staged">
							<p class="text-sm">
								<span class="key">{staged.key}</span>
								<span class="font-semibold">{staged.title}</span>
							</p>
							{#if staged.childCount > 0}
								<label class="flex items-center gap-2 text-sm">
									<input type="checkbox" class="rounded" bind:checked={withChildren} />
									Also add its {staged.childCount}
									{staged.childCount === 1 ? 'Child' : 'Children'}
								</label>
							{/if}
							<div class="flex gap-2">
								<button type="button" class="btn btn-primary" onclick={addStaged}
									>Add to Quest</button
								>
								<button type="button" class="btn btn-quiet" onclick={() => (staged = null)}
									>Cancel</button
								>
							</div>
						</div>
					{/if}
					{#if errors.get('add')}<p role="alert" class="error">{errors.get('add')}</p>{/if}
				</section>

				<section class="panel p-5" aria-labelledby="quest-description-heading">
					<div class="mb-3 flex items-center justify-between gap-2">
						<h2 id="quest-description-heading" class="font-bold tracking-tight">Description</h2>
						{#if !editingBody}
							<button
								class="btn btn-quiet"
								type="button"
								bind:this={editBodyButton}
								onclick={() => {
									bodyDraft = quest.description;
									editingBody = true;
									focusSoon(() => bodyField);
								}}>Edit description</button
							>
						{/if}
					</div>
					{#if editingBody}
						<form
							class="grid gap-2"
							onsubmit={(e) => {
								e.preventDefault();
								const description = bodyDraft;
								closeBody();
								save('description', 'update', { description }, (q) => ({ ...q, description }));
							}}
						>
							<textarea
								class="field min-h-36 w-full font-mono text-sm"
								aria-label="Quest description (Markdown)"
								maxlength="50000"
								bind:this={bodyField}
								bind:value={bodyDraft}></textarea>
							<div class="flex gap-2">
								<button class="btn btn-primary" type="submit">Save description</button>
								<button class="btn btn-quiet" type="button" onclick={closeBody}>Cancel</button>
							</div>
						</form>
					{:else}
						<Markdown source={quest.description} />
					{/if}
					{#if errors.get('description')}<p role="alert" class="error mt-2">
							{errors.get('description')}
						</p>{/if}
				</section>

				<form method="POST" action="?/delete" use:enhance class="panel p-5">
					<ConfirmButton type="submit" label="Delete Quest" confirm="Delete {quest.name}" />
					<p class="mt-2 text-xs text-muted">Its Labours stay where they are.</p>
				</form>
			</aside>
		</div>
	</main>
	<p class="sr-only" aria-live="assertive">{announcement}</p>
{/if}

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

	.lifted {
		position: relative;
		z-index: 1;
		box-shadow:
			inset 0 0 0 2px var(--color-xp),
			0 10px 24px -16px var(--color-xp);
	}

	.slot {
		margin: 0.25rem 0.5rem;
		border: 2px dashed color-mix(in srgb, var(--color-xp) 45%, var(--color-line));
		border-radius: 0.6rem;
		background: color-mix(in srgb, var(--color-xp) 8%, transparent);
	}
</style>
