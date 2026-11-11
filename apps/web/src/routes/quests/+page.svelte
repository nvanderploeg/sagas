<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Avatar from '#lib/components/Avatar.svelte';
	import XpBar from '#lib/components/XpBar.svelte';
	import { applyToQuestList } from '#lib/live/apply.ts';
	import type { QuestListView } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { lookFor } from '#lib/ui/directory.ts';
	import { directory } from '#lib/ui/people.ts';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// svelte-ignore state_referenced_locally
	const live = new LiveView<QuestListView>(data.seq, data.list, applyToQuestList);
	$effect(() => live.load(data.list, data.seq));

	const list = $derived(live.current!);
	const people = $derived(directory(data.people));
	$effect(() =>
		lookFor(
			list.quests.map((q) => q.ownerId),
			people
		)
	);
	const failed = $derived(form && 'error' in form ? form : null);

	let showArchived = $state(false);
	const shown = $derived(list.quests.filter((q) => !!q.archivedAt === showArchived));
	const archivedCount = $derived(list.quests.filter((q) => q.archivedAt).length);
	const complete = (q: (typeof list.quests)[number]) =>
		q.progress.total > 0 && q.progress.closed === q.progress.total;
</script>

<svelte:head>
	<title>Quests · sagas</title>
</svelte:head>

<main class="mx-auto grid max-w-5xl gap-6 px-4 pt-4 pb-16">
	<div>
		<h1 class="text-4xl font-extrabold tracking-tight">Quests</h1>
		<p class="mt-1 max-w-prose text-muted">
			A Quest belongs to a Realm, which decides who sees and edits it, and gathers Labours from any
			Realm you can see. It is complete when every one of them is Closed.
		</p>
	</div>

	<form
		method="POST"
		action="?/create"
		use:enhance
		class="panel grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
	>
		<label class="grid gap-1">
			<span class="label">New Quest</span>
			<input name="name" required maxlength="120" placeholder="Name" class="field" />
		</label>
		<label class="grid gap-1">
			<span class="label">Realm</span>
			<select name="realmId" required class="field">
				{#each list.realms as realm (realm.id)}
					<option value={realm.id}>{realm.name} ({realm.key})</option>
				{/each}
			</select>
		</label>
		<button type="submit" class="btn btn-primary" disabled={list.realms.length === 0}>
			Create Quest
		</button>
		{#if failed}<p role="alert" class="error sm:col-span-2">{failed.error}</p>{/if}
	</form>

	{#if archivedCount > 0 || showArchived}
		<div class="flex gap-2" role="group" aria-label="Quest filter">
			<button
				type="button"
				class="btn {showArchived ? 'btn-quiet' : 'btn-primary'}"
				aria-pressed={!showArchived}
				onclick={() => (showArchived = false)}>Active</button
			>
			<button
				type="button"
				class="btn {showArchived ? 'btn-primary' : 'btn-quiet'}"
				aria-pressed={showArchived}
				onclick={() => (showArchived = true)}>Archived ({archivedCount})</button
			>
		</div>
	{/if}

	{#if shown.length === 0}
		<p class="panel p-6 text-muted">
			{showArchived
				? 'No archived Quests.'
				: 'No Quests yet. Name one above, then add its Labours.'}
		</p>
	{:else}
		<ul class="grid gap-3 md:grid-cols-2">
			{#each shown as quest (quest.id)}
				{@const owner = people.get(quest.ownerId)}
				<li class="panel grid gap-3 p-4" data-testid="quest-card">
					<div class="flex items-start justify-between gap-3">
						<a
							href={resolve('/quests/[id]', { id: String(quest.id) })}
							class="text-lg font-bold tracking-tight hover:underline">{quest.name}</a
						>
						{#if owner}<Avatar person={owner} size="sm" title="Owner: {owner.displayName}" />{/if}
					</div>
					<p class="key">{list.realms.find((r) => r.id === quest.realmId)?.key}</p>
					<XpBar closed={quest.progress.closed} total={quest.progress.total} />
					{#if showArchived}
						<form method="POST" action="?/unarchive" use:enhance>
							<input type="hidden" name="questId" value={quest.id} />
							<button type="submit" class="btn btn-quiet">Unarchive</button>
						</form>
					{:else if complete(quest)}
						<form method="POST" action="?/archive" use:enhance>
							<input type="hidden" name="questId" value={quest.id} />
							<button type="submit" class="btn btn-primary">Archive</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
