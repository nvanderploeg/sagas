<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Avatar from '#lib/components/Avatar.svelte';
	import Burst from '#lib/components/Burst.svelte';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import StatePill from '#lib/components/StatePill.svelte';
	import TicketPicker, { type Match } from '#lib/components/TicketPicker.svelte';
	import TicketRow from '#lib/components/TicketRow.svelte';
	import { applyToTicketPage, touchedTickets } from '#lib/live/apply.ts';
	import type { LiveEvent, Ticket, TicketPageView } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { act, type Fields } from '#lib/ui/act.ts';
	import { FALLBACK_STATE, stateOf } from '#lib/ui/lookup.ts';
	import { directory, personColor, type Person } from '#lib/ui/people.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const me = $derived(data.user!);
	let glow = $state<{ actor: Person; n: number } | null>(null);
	let glows = 0;

	// svelte-ignore state_referenced_locally
	const live = new LiveView<TicketPageView>(data.seq, data.page, applyToTicketPage, {
		onEvent(event: LiveEvent, _before: TicketPageView, after: TicketPageView) {
			if (event.actor.id === me.id) return;
			if (!touchedTickets(event).includes(after.ticket.id)) return;
			const n = ++glows;
			glow = { actor: event.actor, n };
			setTimeout(() => glow?.n === n && (glow = null), 2600);
		}
	});
	$effect(() => live.load(data.page, data.seq));

	const view = $derived(live.current);
	const people = $derived(directory(data.people));
	const errors = new SvelteMap<string, string>();

	// The key in the address follows the Ticket through moves and Project key renames.
	$effect(() => {
		const key = view?.ticket.key;
		if (key && resolve('/t/[key]', { key }) !== location.pathname) {
			goto(resolve('/t/[key]', { key }), { replace: true, shallow: true });
		}
	});

	let bursts = $state(0);
	let wasClosed: boolean | null = null;
	$effect(() => {
		const closed = view?.ticket.closed;
		if (closed === undefined) return;
		if (wasClosed === false && closed) bursts += 1;
		wasClosed = closed;
	});

	async function save(
		scope: string,
		name: string,
		fields: Fields,
		patch: (v: TicketPageView) => TicketPageView
	) {
		if (!view) return;
		errors.delete(scope);
		try {
			await live.mutate(patch, () => act(name, { ticketId: view.ticket.id, ...fields }));
			return true;
		} catch (error) {
			errors.set(scope, (error as Error).message);
			return false;
		}
	}

	const withTicket = (patch: Partial<Ticket>) => (v: TicketPageView) => ({
		...v,
		ticket: { ...v.ticket, ...patch }
	});

	const where = $derived(view ? stateOf(view.projects, view.ticket) : null);
	const project = $derived(where?.project);

	let editingTitle = $state(false);
	let titleDraft = $state('');
	let editingBody = $state(false);
	let bodyDraft = $state('');
	let preview = $state(false);

	async function saveTitle() {
		const title = titleDraft.trim();
		if (!title) return;
		editingTitle = false;
		await save('title', 'update', { title }, withTicket({ title }));
	}

	async function saveBody() {
		editingBody = false;
		await save(
			'description',
			'update',
			{ description: bodyDraft },
			withTicket({ description: bodyDraft })
		);
	}

	function setState(stateId: number) {
		const state = project?.states.find((s) => s.id === stateId);
		if (!state) return;
		const substateId = state.substates.length > 0 ? state.defaultSubstateId : null;
		save(
			'state',
			'update',
			{ stateId },
			withTicket({ stateId, substateId, closed: state.isClosed })
		);
	}

	function setParent(parent: Match | null) {
		save('parent', 'parent', { parentId: parent?.id ?? null }, (v) => ({
			...v,
			ticket: { ...v.ticket, parentId: parent?.id ?? null },
			parent
		}));
	}

	function questMembership(questId: number, join: boolean) {
		save('quests', join ? 'addQuest' : 'removeQuest', { questId }, (v) => ({
			...v,
			memberOf: [...v.memberOf.filter((id) => id !== questId), ...(join ? [questId] : [])].sort(
				(a, b) => a - b
			)
		}));
	}

	let moveProjectId = $state<number | null>(null);
	let moveStateId = $state<number | null>(null);
	let moveSubstateId = $state<number | null>(null);
	const moveTarget = $derived(view?.projects.find((p) => p.id === moveProjectId));
	const moveStates = $derived(
		moveTarget ? moveTarget.states.filter((s) => s.isClosed === (view?.ticket.closed ?? false)) : []
	);
	const moveState = $derived(moveStates.find((s) => s.id === moveStateId) ?? moveStates[0]);

	function pickMoveProject(id: number | null) {
		moveProjectId = id;
		const target = view?.projects.find((p) => p.id === id);
		const states =
			target?.states.filter((s) => s.isClosed === (view?.ticket.closed ?? false)) ?? [];
		const state = states.find((s) => s.id === target?.initialStateId) ?? states[0];
		moveStateId = state?.id ?? null;
		moveSubstateId = state && state.substates.length > 0 ? state.defaultSubstateId : null;
	}

	let moving = $state(false);
	async function move() {
		if (!view || !moveTarget || !moveState) return;
		moving = true;
		errors.delete('move');
		try {
			const done = await act('move', {
				ticketId: view.ticket.id,
				projectId: moveTarget.id,
				stateId: moveState.id,
				substateId: moveState.substates.length > 0 ? moveSubstateId : null
			});
			moveProjectId = null;
			await goto(resolve('/t/[key]', { key: String(done.key) }), { replace: true, reset: false });
		} catch (error) {
			errors.set('move', (error as Error).message);
		} finally {
			moving = false;
		}
	}

	const owner = $derived(view ? people.get(view.ticket.ownerId) : undefined);
	const joinable = $derived(view ? view.quests.filter((q) => !view.memberOf.includes(q.id)) : []);
	let questToAdd = $state<number | null>(null);
</script>

<svelte:head>
	<title>{view ? `${view.ticket.key} ${view.ticket.title}` : 'Deleted Ticket'} · workload</title>
</svelte:head>

{#if !view}
	<main class="mx-auto max-w-3xl px-4 py-16">
		<div class="panel p-8">
			<h1 class="text-2xl font-bold tracking-tight">This Ticket was deleted</h1>
			<p class="mt-2 text-muted">Someone deleted it while you had it open.</p>
			<a class="btn mt-4" href={resolve('/')}>Go home</a>
		</div>
	</main>
{:else}
	{@const ticket = view.ticket}
	{@const state = where?.state}
	<main class="mx-auto grid max-w-6xl gap-6 px-4 pt-2 pb-16">
		{#if project}
			<a
				class="w-fit text-sm text-muted hover:text-ink"
				href={resolve('/p/[key]', { key: project.key })}>← {project.name}</a
			>
		{/if}

		<header
			class="head"
			class:glowing={glow}
			style:--sc={state?.color ?? '#9ca3af'}
			style:--gc={glow ? personColor(glow.actor.username) : undefined}
		>
			<div class="flex flex-wrap items-center gap-2">
				<span class="key text-sm" data-testid="ticket-key">{ticket.key}</span>
				<span class="relative inline-flex">
					<StatePill def={state ?? FALLBACK_STATE} />
					{#key bursts}{#if bursts}<Burst color={state?.color} />{/if}{/key}
				</span>
				{#if where?.substate}<StatePill def={where.substate} variant="badge" />{/if}
				{#if glow}
					{#key glow.n}
						<span class="editor" data-testid="remote-editor">
							<Avatar person={glow.actor} size="xs" /> changed by {glow.actor.displayName}
						</span>
					{/key}
				{/if}
			</div>
			{#if editingTitle}
				<form
					class="mt-2 flex flex-wrap gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						saveTitle();
					}}
				>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="field min-w-0 flex-1 text-xl font-bold"
						aria-label="Title"
						maxlength="200"
						required
						autofocus
						bind:value={titleDraft}
						onkeydown={(e) => e.key === 'Escape' && (editingTitle = false)}
					/>
					<button class="btn btn-primary" type="submit">Save title</button>
					<button class="btn btn-quiet" type="button" onclick={() => (editingTitle = false)}
						>Cancel</button
					>
				</form>
			{:else}
				<div class="mt-2 flex flex-wrap items-start gap-2">
					<h1 class="title">{ticket.title}</h1>
					<button
						class="btn btn-quiet"
						type="button"
						onclick={() => {
							titleDraft = ticket.title;
							editingTitle = true;
						}}>Edit title</button
					>
				</div>
			{/if}
			{#if errors.get('title')}<p role="alert" class="error mt-1">{errors.get('title')}</p>{/if}
		</header>

		<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div class="grid min-w-0 gap-6">
				<section class="panel p-5" aria-labelledby="description-heading">
					<div class="mb-3 flex items-center justify-between gap-2">
						<h2 id="description-heading" class="font-bold tracking-tight">Description</h2>
						{#if !editingBody}
							<button
								class="btn btn-quiet"
								type="button"
								onclick={() => {
									bodyDraft = ticket.description;
									preview = false;
									editingBody = true;
								}}>Edit description</button
							>
						{/if}
					</div>
					{#if editingBody}
						<div class="grid gap-3">
							<div class="flex gap-1" role="tablist" aria-label="Description editor">
								<button
									type="button"
									role="tab"
									class="btn btn-quiet"
									aria-selected={!preview}
									class:active={!preview}
									onclick={() => (preview = false)}>Write</button
								>
								<button
									type="button"
									role="tab"
									class="btn btn-quiet"
									aria-selected={preview}
									class:active={preview}
									onclick={() => (preview = true)}>Preview</button
								>
							</div>
							{#if preview}
								<div class="min-h-32 rounded-lg border border-line p-3">
									<Markdown source={bodyDraft} empty="Nothing to preview." />
								</div>
							{:else}
								<textarea
									class="field min-h-48 w-full font-mono text-sm"
									aria-label="Description (Markdown)"
									maxlength="50000"
									bind:value={bodyDraft}></textarea>
							{/if}
							<div class="flex gap-2">
								<button class="btn btn-primary" type="button" onclick={saveBody}
									>Save description</button
								>
								<button class="btn btn-quiet" type="button" onclick={() => (editingBody = false)}
									>Cancel</button
								>
							</div>
						</div>
					{:else}
						<Markdown source={ticket.description} />
					{/if}
					{#if errors.get('description')}<p role="alert" class="error mt-2">
							{errors.get('description')}
						</p>{/if}
				</section>

				<section class="panel overflow-hidden" aria-labelledby="children-heading">
					<h2 id="children-heading" class="px-5 pt-4 pb-2 font-bold tracking-tight">
						Children <span class="font-normal text-muted">{view.children.length}</span>
					</h2>
					{#if view.children.length === 0}
						<p class="px-5 pb-5 text-sm text-muted">
							No Children. A Ticket becomes a Child when its Parent is set to {ticket.key}.
						</p>
					{:else}
						<ul class="divide-y divide-line border-t border-line" data-testid="children">
							{#each view.children as child (child.id)}
								<li><TicketRow ticket={child} projects={view.projects} {people} /></li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>

			<aside class="panel grid gap-5 p-5" aria-label="Ticket fields">
				<div class="grid gap-1.5">
					<label class="label" for="state">State</label>
					<select
						id="state"
						class="field"
						value={ticket.stateId}
						onchange={(e) => setState(Number(e.currentTarget.value))}
					>
						{#each project?.states ?? [] as option (option.id)}
							<option value={option.id}>{option.label}</option>
						{/each}
					</select>
					{#if state && state.substates.length > 0}
						<label class="label mt-1" for="substate">Substate</label>
						<select
							id="substate"
							class="field"
							value={ticket.substateId}
							onchange={(e) => {
								const substateId = Number(e.currentTarget.value);
								save('state', 'update', { substateId }, withTicket({ substateId }));
							}}
						>
							{#each state.substates as option (option.id)}
								<option value={option.id}>{option.label}</option>
							{/each}
						</select>
					{/if}
					{#if errors.get('state')}<p role="alert" class="error">{errors.get('state')}</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<label class="label" for="owner">Owner</label>
					<div class="flex items-center gap-2">
						{#if owner}<Avatar person={owner} size="sm" />{/if}
						<select
							id="owner"
							class="field min-w-0 flex-1"
							value={ticket.ownerId}
							onchange={(e) => {
								const ownerId = Number(e.currentTarget.value);
								save('owner', 'update', { ownerId }, withTicket({ ownerId }));
							}}
						>
							{#each data.people as person (person.id)}
								<option value={person.id}>{person.displayName}</option>
							{/each}
						</select>
					</div>
					{#if errors.get('owner')}<p role="alert" class="error">{errors.get('owner')}</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<label class="label" for="assignee">Assignee</label>
					<select
						id="assignee"
						class="field"
						value={ticket.assigneeId ?? ''}
						onchange={(e) => {
							const v = e.currentTarget.value;
							const assigneeId = v === '' ? null : Number(v);
							save('assignee', 'update', { assigneeId }, withTicket({ assigneeId }));
						}}
					>
						<option value="">Unassigned</option>
						{#each data.people as person (person.id)}
							<option value={person.id}>{person.displayName}</option>
						{/each}
					</select>
					{#if errors.get('assignee')}<p role="alert" class="error">
							{errors.get('assignee')}
						</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<span class="label">Parent</span>
					{#if view.parent}
						<div class="rounded-lg border border-line" data-testid="parent">
							<TicketRow ticket={view.parent} projects={view.projects} {people}>
								{#snippet actions()}
									<button class="btn btn-quiet" type="button" onclick={() => setParent(null)}
										>Clear</button
									>
								{/snippet}
							</TicketRow>
						</div>
					{:else}
						<p class="text-sm text-muted">None</p>
					{/if}
					<TicketPicker
						label={view.parent ? 'Change Parent' : 'Set Parent'}
						exclude={[ticket.id, ...view.children.map((c) => c.id)]}
						onpick={(picked) => setParent(picked)}
					/>
					{#if errors.get('parent')}<p role="alert" class="error">{errors.get('parent')}</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<span class="label">Quests</span>
					{#if view.memberOf.length === 0}
						<p class="text-sm text-muted">In no Quest.</p>
					{:else}
						<ul class="flex flex-wrap gap-1.5" data-testid="ticket-quests">
							{#each view.memberOf as questId (questId)}
								{@const quest = view.quests.find((q) => q.id === questId)}
								<li class="chip">
									<a href={resolve('/quests/[id]', { id: String(questId) })}>{quest?.name}</a>
									<button
										type="button"
										aria-label="Remove from {quest?.name}"
										onclick={() => questMembership(questId, false)}>✕</button
									>
								</li>
							{/each}
						</ul>
					{/if}
					{#if joinable.length > 0}
						<div class="flex gap-2">
							<select
								class="field min-w-0 flex-1"
								aria-label="Quest to add this Ticket to"
								bind:value={questToAdd}
							>
								<option value={null}>Choose a Quest</option>
								{#each joinable as quest (quest.id)}
									<option value={quest.id}>{quest.name}</option>
								{/each}
							</select>
							<button
								class="btn"
								type="button"
								disabled={questToAdd === null}
								onclick={() => {
									if (questToAdd !== null) questMembership(questToAdd, true);
									questToAdd = null;
								}}>Add</button
							>
						</div>
					{/if}
					{#if errors.get('quests')}<p role="alert" class="error">{errors.get('quests')}</p>{/if}
				</div>

				<details class="group grid gap-2" open={moveProjectId !== null}>
					<summary class="label cursor-pointer select-none">Move to another Project</summary>
					<div class="mt-2 grid gap-2">
						<select
							class="field"
							aria-label="Target Project"
							value={moveProjectId ?? ''}
							onchange={(e) =>
								pickMoveProject(
									e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
								)}
						>
							<option value="">Choose a Project</option>
							{#each view.projects.filter((p) => p.id !== ticket.projectId) as option (option.id)}
								<option value={option.id}>{option.name} ({option.key})</option>
							{/each}
						</select>
						{#if moveTarget}
							<select
								class="field"
								aria-label="Target State"
								disabled={ticket.closed}
								value={moveState?.id}
								onchange={(e) => {
									moveStateId = Number(e.currentTarget.value);
									const s = moveStates.find((x) => x.id === moveStateId);
									moveSubstateId = s && s.substates.length > 0 ? s.defaultSubstateId : null;
								}}
							>
								{#each moveStates as option (option.id)}
									<option value={option.id}>{option.label}</option>
								{/each}
							</select>
							{#if ticket.closed}
								<p class="text-xs text-muted">A Closed Ticket stays Closed.</p>
							{/if}
							{#if moveState && moveState.substates.length > 0}
								<select
									class="field"
									aria-label="Target Substate"
									value={moveSubstateId}
									onchange={(e) => (moveSubstateId = Number(e.currentTarget.value))}
								>
									{#each moveState.substates as option (option.id)}
										<option value={option.id}>{option.label}</option>
									{/each}
								</select>
							{/if}
							<button class="btn btn-primary" type="button" disabled={moving} onclick={move}
								>Move to {moveTarget.key}</button
							>
							<p class="text-xs text-muted">
								It gets a new key; {ticket.key} keeps leading here. Parent and Children stay put.
							</p>
						{/if}
						{#if errors.get('move')}<p role="alert" class="error">{errors.get('move')}</p>{/if}
					</div>
				</details>

				<form method="POST" action="?/delete" use:enhance class="border-t border-line pt-4">
					<input type="hidden" name="ticketId" value={ticket.id} />
					<ConfirmButton
						type="submit"
						label="Delete Ticket"
						confirm="Delete {ticket.key} for good"
					/>
				</form>
			</aside>
		</div>
	</main>
{/if}

<style>
	.head {
		position: relative;
		padding: 1.1rem 1.25rem 1.1rem 1.5rem;
		border: 1px solid var(--color-line);
		border-radius: 1rem;
		background: var(--color-panel);
		overflow: visible;
	}

	.head::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 0.4rem;
		border-radius: 1rem 0 0 1rem;
		background: var(--sc);
		transition: background-color 0.4s ease;
	}

	.glowing {
		animation: glow 2.4s ease-out;
	}

	.title {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: clamp(1.5rem, 4vw, 2.2rem);
		font-weight: 750;
		letter-spacing: -0.02em;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.editor {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-muted);
		font-size: 0.8rem;
		animation: fade 2.6s ease-out forwards;
	}

	.active {
		background: var(--color-panel-2);
		color: var(--color-ink);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.35rem 0.15rem 0.65rem;
		border: 1px solid color-mix(in srgb, var(--color-xp) 40%, var(--color-line));
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-xp) 10%, var(--color-panel));
		font-size: 0.85rem;
		font-weight: 600;
	}

	.chip button {
		display: grid;
		place-items: center;
		width: 1.2rem;
		height: 1.2rem;
		border-radius: 999px;
		color: var(--color-muted);
		font-size: 0.65rem;
		cursor: pointer;
	}

	.chip button:hover {
		background: var(--color-panel-2);
		color: var(--color-ink);
	}

	summary::-webkit-details-marker {
		color: var(--color-muted);
	}

	@keyframes glow {
		0% {
			box-shadow:
				0 0 0 2px var(--gc),
				0 0 26px color-mix(in srgb, var(--gc) 55%, transparent);
		}
		100% {
			box-shadow: 0 0 0 2px transparent;
		}
	}

	@keyframes fade {
		0%,
		75% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.glowing,
		.editor {
			animation: none;
		}
	}
</style>
