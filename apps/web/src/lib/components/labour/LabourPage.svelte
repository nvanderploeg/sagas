<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import LabourLayer from '#lib/components/agent/LabourLayer.svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import Burst from '#lib/components/Burst.svelte';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import StatePill from '#lib/components/StatePill.svelte';
	import LabourPicker, { type Match } from '#lib/components/LabourPicker.svelte';
	import LabourRow from '#lib/components/LabourRow.svelte';
	import { applyToLabourPage, touchedLabours } from '#lib/live/apply.ts';
	import type { LiveEvent, Labour, LabourPageView } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { act, type Fields } from '#lib/ui/act.ts';
	import { lookFor, usersOf } from '#lib/ui/directory.ts';
	import { FALLBACK_STATE, stateOf } from '#lib/ui/lookup.ts';
	import { directory, personColor, type Person } from '#lib/ui/people.ts';
	import { stamp } from '#lib/ui/time.ts';

	let {
		seq,
		page: loaded,
		me,
		people: everyone
	}: { seq: number; page: LabourPageView; me: Person; people: Person[] } = $props();

	let glow = $state<{ actor: Person; n: number } | null>(null);
	let glows = 0;

	// svelte-ignore state_referenced_locally
	const live = new LiveView<LabourPageView>(seq, loaded, applyToLabourPage, {
		onEvent(event: LiveEvent, _before: LabourPageView, after: LabourPageView) {
			if (event.actor.id === me.id && !event.actor.via) return;
			if (!touchedLabours(event).includes(after.labour.id)) return;
			const n = ++glows;
			glow = { actor: event.actor, n };
			setTimeout(() => glow?.n === n && (glow = null), 2600);
		}
	});
	$effect(() => live.load(loaded, seq));

	// The last view shown, held while one's own delete is on its way to the board.
	let kept = $state.raw<LabourPageView | null>(null);
	let deleting = $state(false);
	$effect(() => {
		if (live.current) kept = live.current;
	});
	const view = $derived(live.current ?? (deleting ? kept : null));
	const people = $derived(directory(everyone));
	const errors = new SvelteMap<string, string>();

	$effect(() => {
		if (!view) return;
		const { labour, parent, children } = view;
		lookFor(usersOf([labour, ...(parent ? [parent] : []), ...children]), people);
		lookFor(
			view.comments.map((c) => c.authorId),
			people
		);
	});

	$effect(() => {
		const key = view?.labour.key;
		if (key && resolve('/l/[key]', { key }) !== location.pathname) {
			goto(resolve('/l/[key]', { key }), { replace: true, shallow: true });
		}
	});

	// Only a Labour this view already showed open bursts on closing.
	let bursts = $state(0);
	let lastSeen: { id: number; closed: boolean } | null = null;
	$effect(() => {
		if (!view) return;
		const { id, closed } = view.labour;
		if (lastSeen?.id === id && !lastSeen.closed && closed) bursts += 1;
		lastSeen = { id, closed };
	});

	async function save(
		scope: string,
		name: string,
		fields: Fields,
		patch: (v: LabourPageView) => LabourPageView
	) {
		if (!view) return;
		errors.delete(scope);
		try {
			await live.mutate(patch, () => act(name, { labourId: view.labour.id, ...fields }));
			return true;
		} catch (error) {
			errors.set(scope, (error as Error).message);
			return false;
		}
	}

	const withLabour = (patch: Partial<Labour>) => (v: LabourPageView) => ({
		...v,
		labour: { ...v.labour, ...patch }
	});

	const where = $derived(view ? stateOf(view.realms, view.labour) : null);
	const realm = $derived(where?.realm);

	let editingTitle = $state(false);
	let titleDraft = $state('');
	let editingBody = $state(false);
	let bodyDraft = $state('');
	let preview = $state(false);
	let editTitleButton = $state<HTMLButtonElement | null>(null);
	let editBodyButton = $state<HTMLButtonElement | null>(null);
	let bodyField = $state<HTMLTextAreaElement | null>(null);

	// The control pressed goes away with the editor; focus moves to the one that takes its place.
	async function focusSoon(target: () => HTMLElement | null) {
		await tick();
		target()?.focus();
	}

	function closeTitle() {
		editingTitle = false;
		focusSoon(() => editTitleButton);
	}

	function openBody(description: string) {
		bodyDraft = description;
		preview = false;
		editingBody = true;
		focusSoon(() => bodyField);
	}

	function closeBody() {
		editingBody = false;
		focusSoon(() => editBodyButton);
	}

	async function saveTitle() {
		const title = titleDraft.trim();
		if (!title) return;
		closeTitle();
		await save('title', 'update', { title }, withLabour({ title }));
	}

	async function saveBody() {
		const description = bodyDraft;
		closeBody();
		await save('description', 'update', { description }, withLabour({ description }));
	}

	function setState(stateId: number) {
		const state = realm?.states.find((s) => s.id === stateId);
		if (!state) return;
		const substateId = state.substates.length > 0 ? state.defaultSubstateId : null;
		save(
			'state',
			'update',
			{ stateId },
			withLabour({ stateId, substateId, closed: state.isClosed })
		);
	}

	function setParent(picked: Match | null) {
		const parent: Labour | null = picked && { ...picked };
		if (parent) delete (parent as Partial<Match>).childCount;
		save('parent', 'parent', { parentId: parent?.id ?? null }, (v) => ({
			...v,
			labour: { ...v.labour, parentId: parent?.id ?? null },
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

	let moveOpen = $state(false);
	let moveRealmId = $state<number | null>(null);
	let moveStateId = $state<number | null>(null);
	let moveSubstateId = $state<number | null>(null);
	const moveChoices = $derived(view ? view.realms.filter((p) => p.id !== view.labour.realmId) : []);
	const moveTarget = $derived(moveChoices.find((p) => p.id === moveRealmId));
	$effect(() => {
		if (moveRealmId !== null && !moveTarget) moveRealmId = null;
	});
	const moveStates = $derived(
		moveTarget ? moveTarget.states.filter((s) => s.isClosed === (view?.labour.closed ?? false)) : []
	);
	const moveState = $derived(moveStates.find((s) => s.id === moveStateId) ?? moveStates[0]);

	function pickMoveRealm(id: number | null) {
		moveRealmId = id;
		const target = view?.realms.find((p) => p.id === id);
		const states =
			target?.states.filter((s) => s.isClosed === (view?.labour.closed ?? false)) ?? [];
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
				labourId: view.labour.id,
				realmId: moveTarget.id,
				stateId: moveState.id,
				substateId: moveState.substates.length > 0 ? moveSubstateId : null
			});
			moveRealmId = null;
			moveOpen = false;
			await goto(resolve('/l/[key]', { key: String(done.key) }), { replace: true, reset: false });
		} catch (error) {
			errors.set('move', (error as Error).message);
		} finally {
			moving = false;
		}
	}

	const owner = $derived(view ? people.get(view.labour.ownerId) : undefined);
	const assignee = $derived(
		view?.labour.assigneeId == null ? undefined : people.get(view.labour.assigneeId)
	);
	const joinable = $derived(view ? view.quests.filter((q) => !view.memberOf.includes(q.id)) : []);
	let questToAdd = $state<number | null>(null);
	let commentDraft = $state('');
	let commenting = $state(false);

	let editingComment = $state<number | null>(null);
	let editDraft = $state('');

	function openComment(id: number, body: string) {
		editDraft = body;
		editingComment = id;
	}

	async function saveComment(id: number) {
		if (editDraft.trim() === '') return;
		if (await save('comment', 'editComment', { commentId: id, body: editDraft }, (v) => v)) {
			editingComment = null;
		}
	}

	function removeComment(id: number) {
		void save('comment', 'deleteComment', { commentId: id }, (v) => ({
			...v,
			comments: v.comments.filter((c) => c.id !== id)
		}));
	}

	async function postComment() {
		if (!view || commenting || commentDraft.trim() === '') return;
		commenting = true;
		const saved = await save('comment', 'comment', { body: commentDraft }, (v) => v);
		commenting = false;
		if (saved) commentDraft = '';
	}
	let labelDraft = $state('');

	function setLabels(labels: string[]) {
		const next = [...new Set(labels.map((l) => l.trim().toLowerCase()))].sort();
		save('labels', 'update', { labels: next.join(' ') }, withLabour({ labels: next }));
	}

	function addLabels() {
		const added = labelDraft.split(/[\s,]+/).filter((l) => l !== '');
		labelDraft = '';
		if (view && added.length > 0) setLabels([...view.labour.labels, ...added]);
	}
</script>

<svelte:head>
	<title>{view ? `${view.labour.key} ${view.labour.title}` : 'Deleted Labour'} · sagas</title>
</svelte:head>

{#if !view}
	<main class="mx-auto max-w-3xl px-4 py-16">
		<div class="panel p-8">
			<h1 class="text-2xl font-bold tracking-tight">This Labour was deleted</h1>
			<p class="mt-2 text-muted">Someone deleted it while you had it open.</p>
			<a class="btn mt-4" href={resolve('/')}>Go home</a>
		</div>
	</main>
{:else}
	{@const labour = view.labour}
	{@const state = where?.state}
	<main class="mx-auto grid max-w-6xl gap-6 px-4 pt-2 pb-16">
		{#if realm}
			<a
				class="w-fit text-sm text-muted hover:text-ink"
				href={resolve('/r/[key]', { key: realm.key })}>← {realm.name}</a
			>
		{/if}

		<header
			class="head"
			class:glowing={glow}
			style:--sc={state?.color ?? '#9ca3af'}
			style:--gc={glow ? personColor(glow.actor.username) : undefined}
		>
			<div class="flex flex-wrap items-center gap-2">
				<span class="key text-sm" data-testid="labour-key">{labour.key}</span>
				<span class="relative inline-flex">
					<StatePill def={state ?? FALLBACK_STATE} />
					{#key bursts}{#if bursts}<Burst color={state?.color} />{/if}{/key}
				</span>
				{#if where?.substate}<StatePill def={where.substate} variant="badge" />{/if}
				{#if glow}
					{#key glow.n}
						<span class="editor" data-testid="remote-editor">
							<Avatar person={glow.actor} size="xs" /> changed by {glow.actor.displayName}{glow
								.actor.via
								? ` (${glow.actor.via.name})`
								: ''}
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
						onkeydown={(e) => e.key === 'Escape' && closeTitle()}
					/>
					<button class="btn btn-primary" type="submit">Save title</button>
					<button class="btn btn-quiet" type="button" onclick={closeTitle}>Cancel</button>
				</form>
			{:else}
				<div class="mt-2 flex flex-wrap items-start gap-2">
					<h1 class="title">{labour.title}</h1>
					<button
						class="btn btn-quiet"
						type="button"
						bind:this={editTitleButton}
						onclick={() => {
							titleDraft = labour.title;
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
								bind:this={editBodyButton}
								onclick={() => openBody(labour.description)}>Edit description</button
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
									bind:this={bodyField}
									bind:value={bodyDraft}></textarea>
							{/if}
							<div class="flex gap-2">
								<button class="btn btn-primary" type="button" onclick={saveBody}
									>Save description</button
								>
								<button class="btn btn-quiet" type="button" onclick={closeBody}>Cancel</button>
							</div>
						</div>
					{:else}
						<Markdown source={labour.description} />
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
						<p class="px-5 pb-5 text-sm text-muted">No Children.</p>
					{:else}
						<ul class="divide-y divide-line border-t border-line" data-testid="children">
							{#each view.children as child (child.id)}
								<li><LabourRow labour={child} realms={view.realms} {people} /></li>
							{/each}
						</ul>
					{/if}
				</section>

				<section class="panel overflow-hidden" aria-labelledby="comments-heading">
					<h2 id="comments-heading" class="px-5 pt-4 pb-2 font-bold tracking-tight">
						Comments <span class="font-normal text-muted">{view.comments.length}</span>
					</h2>
					{#if view.comments.length === 0}
						<p class="px-5 pb-3 text-sm text-muted">No Comments yet.</p>
					{:else}
						<ul class="divide-y divide-line border-t border-line" data-testid="comments">
							{#each view.comments as comment (comment.id)}
								{@const author = people.get(comment.authorId)}
								<li class="grid gap-2 px-5 py-3">
									<div class="flex items-center gap-2 text-sm">
										{#if author}<Avatar person={author} size="xs" />{/if}
										<span class="font-semibold">{author?.displayName ?? 'Someone'}</span>
										{#if comment.via}<span class="text-xs text-muted">({comment.via})</span>{/if}
										<time class="text-xs text-muted" datetime={comment.createdAt}
											>{stamp(comment.createdAt)}</time
										>
										{#if comment.updatedAt}<span class="text-xs text-muted">(edited)</span>{/if}
									</div>
									{#if editingComment === comment.id}
										<textarea
											class="field min-h-24 w-full text-sm"
											aria-label="Edit Comment (Markdown)"
											maxlength="20000"
											bind:value={editDraft}></textarea>
										<div class="flex gap-2">
											<button
												class="btn btn-primary"
												type="button"
												disabled={editDraft.trim() === ''}
												onclick={() => saveComment(comment.id)}>Save Comment</button
											>
											<button
												class="btn btn-quiet"
												type="button"
												onclick={() => (editingComment = null)}>Cancel</button
											>
										</div>
									{:else}
										<Markdown source={comment.body} />
										{#if comment.authorId === me.id}
											<div class="flex gap-2">
												<button
													class="btn btn-quiet"
													type="button"
													onclick={() => openComment(comment.id, comment.body)}>Edit Comment</button
												>
												<ConfirmButton
													label="Delete Comment"
													confirm="Delete this Comment for good"
													onconfirm={() => removeComment(comment.id)}
												/>
											</div>
										{/if}
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<form
						class="grid gap-2 border-t border-line p-5"
						onsubmit={(e) => {
							e.preventDefault();
							void postComment();
						}}
					>
						<textarea
							class="field min-h-24 w-full text-sm"
							aria-label="New Comment (Markdown)"
							maxlength="20000"
							bind:value={commentDraft}></textarea>
						<div class="flex items-center gap-2">
							<button
								class="btn btn-primary"
								type="submit"
								disabled={commenting || commentDraft.trim() === ''}>Comment</button
							>
							{#if errors.get('comment')}<p role="alert" class="error">
									{errors.get('comment')}
								</p>{/if}
						</div>
					</form>
				</section>
			</div>

			<aside class="panel grid gap-5 p-5" aria-label="Labour fields">
				<div class="grid gap-1.5">
					<label class="label" for="state">State</label>
					<select
						id="state"
						class="field"
						value={labour.stateId}
						onchange={(e) => setState(Number(e.currentTarget.value))}
					>
						{#each realm?.states ?? [] as option (option.id)}
							<option value={option.id}>{option.label}</option>
						{/each}
					</select>
					{#if state && state.next.length > 0}
						<div class="flex flex-wrap gap-1.5" data-testid="next-states">
							{#each state.next as id (id)}
								{@const target = realm?.states.find((s) => s.id === id)}
								{#if target}
									<button class="btn btn-quiet text-xs" type="button" onclick={() => setState(id)}
										>→ {target.label}</button
									>
								{/if}
							{/each}
						</div>
					{/if}
					{#if state && state.substates.length > 0}
						<label class="label mt-1" for="substate">Substate</label>
						<select
							id="substate"
							class="field"
							value={labour.substateId}
							onchange={(e) => {
								const substateId = Number(e.currentTarget.value);
								save('state', 'update', { substateId }, withLabour({ substateId }));
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
							value={labour.ownerId}
							onchange={(e) => {
								const ownerId = Number(e.currentTarget.value);
								save('owner', 'update', { ownerId }, withLabour({ ownerId }));
							}}
						>
							{#if !owner}<option value={labour.ownerId}>Loading…</option>{/if}
							{#each everyone as person (person.id)}
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
						value={labour.assigneeId ?? ''}
						onchange={(e) => {
							const v = e.currentTarget.value;
							const assigneeId = v === '' ? null : Number(v);
							save('assignee', 'update', { assigneeId }, withLabour({ assigneeId }));
						}}
					>
						<option value="">Unassigned</option>
						{#if labour.assigneeId !== null && !assignee}
							<option value={labour.assigneeId}>Loading…</option>
						{/if}
						{#each everyone as person (person.id)}
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
							<LabourRow labour={view.parent} realms={view.realms} {people}>
								{#snippet actions()}
									<button class="btn btn-quiet" type="button" onclick={() => setParent(null)}
										>Clear</button
									>
								{/snippet}
							</LabourRow>
						</div>
					{:else}
						<p class="text-sm text-muted">None</p>
					{/if}
					<LabourPicker
						label={view.parent ? 'Change Parent' : 'Set Parent'}
						exclude={[labour.id, ...view.children.map((c) => c.id)]}
						onpick={(picked) => setParent(picked)}
					/>
					{#if errors.get('parent')}<p role="alert" class="error">{errors.get('parent')}</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<label class="label" for="labels">Labels</label>
					{#if labour.labels.length === 0}
						<p class="text-sm text-muted">No Labels.</p>
					{:else}
						<ul class="flex flex-wrap gap-1.5" data-testid="labour-labels">
							{#each labour.labels as label (label)}
								<li class="chip">
									{label}
									<button
										type="button"
										aria-label="Remove label {label}"
										onclick={() => setLabels(labour.labels.filter((l) => l !== label))}>✕</button
									>
								</li>
							{/each}
						</ul>
					{/if}
					<form
						class="flex gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							addLabels();
						}}
					>
						<input
							id="labels"
							class="field min-w-0 flex-1"
							placeholder="Add labels"
							maxlength="200"
							bind:value={labelDraft}
						/>
						<button
							class="btn"
							type="submit"
							aria-label="Add label"
							disabled={labelDraft.trim() === ''}>Add</button
						>
					</form>
					{#if errors.get('labels')}<p role="alert" class="error">{errors.get('labels')}</p>{/if}
				</div>

				<div class="grid gap-1.5">
					<span class="label">Quests</span>
					{#if view.memberOf.length === 0}
						<p class="text-sm text-muted">In no Quest.</p>
					{:else}
						<ul class="flex flex-wrap gap-1.5" data-testid="labour-quests">
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
								aria-label="Quest to add this Labour to"
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

				<details class="group grid gap-2" bind:open={moveOpen}>
					<summary class="label cursor-pointer select-none">Move to another Realm</summary>
					<div class="mt-2 grid gap-2">
						<select
							class="field"
							aria-label="Target Realm"
							value={moveRealmId ?? ''}
							onchange={(e) =>
								pickMoveRealm(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
						>
							<option value="">Choose a Realm</option>
							{#each moveChoices as option (option.id)}
								<option value={option.id}>{option.name} ({option.key})</option>
							{/each}
						</select>
						{#if moveTarget}
							<select
								class="field"
								aria-label="Target State"
								disabled={labour.closed}
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
							{#if labour.closed}
								<p class="text-xs text-muted">A Closed Labour stays Closed.</p>
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
								It gets a new key; {labour.key} keeps leading here. Parent and Children stay put.
							</p>
						{/if}
						{#if errors.get('move')}<p role="alert" class="error">{errors.get('move')}</p>{/if}
					</div>
				</details>

				<form
					method="POST"
					action="?/delete"
					class="border-t border-line pt-4"
					use:enhance={() => {
						deleting = true;
						return async ({ result, update }) => {
							if (result.type !== 'redirect') deleting = false;
							await update();
						};
					}}
				>
					<input type="hidden" name="labourId" value={labour.id} />
					<ConfirmButton
						type="submit"
						label="Delete Labour"
						confirm="Delete {labour.key} for good"
					/>
				</form>
			</aside>
		</div>
		{#key labour.id}
			<LabourLayer labourId={labour.id} {people} />
		{/key}
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
