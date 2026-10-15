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
</script>

<svelte:head>
	<title>Quests · workload</title>
</svelte:head>

<main class="mx-auto grid max-w-5xl gap-6 px-4 pt-4 pb-16">
	<div>
		<h1 class="text-4xl font-extrabold tracking-tight">Quests</h1>
		<p class="mt-1 max-w-prose text-muted">
			A Quest gathers Tickets from any Project. It is complete when every one of them is Closed.
		</p>
	</div>

	<form
		method="POST"
		action="?/create"
		use:enhance
		class="panel grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-end"
	>
		<label class="grid gap-1">
			<span class="label">New Quest</span>
			<input name="name" required maxlength="120" placeholder="Name" class="field" />
		</label>
		<button type="submit" class="btn btn-primary">Create Quest</button>
		{#if failed}<p role="alert" class="error sm:col-span-2">{failed.error}</p>{/if}
	</form>

	{#if list.quests.length === 0}
		<p class="panel p-6 text-muted">No Quests yet. Name one above, then add its Tickets.</p>
	{:else}
		<ul class="grid gap-3 md:grid-cols-2">
			{#each list.quests as quest (quest.id)}
				{@const owner = people.get(quest.ownerId)}
				<li class="panel grid gap-3 p-4" data-testid="quest-card">
					<div class="flex items-start justify-between gap-3">
						<a
							href={resolve('/quests/[id]', { id: String(quest.id) })}
							class="text-lg font-bold tracking-tight hover:underline">{quest.name}</a
						>
						{#if owner}<Avatar person={owner} size="sm" title="Owner: {owner.displayName}" />{/if}
					</div>
					<XpBar closed={quest.progress.closed} total={quest.progress.total} />
				</li>
			{/each}
		</ul>
	{/if}
</main>
