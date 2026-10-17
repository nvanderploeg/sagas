<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import StatePill from '#lib/components/StatePill.svelte';
	import LabourRow from '#lib/components/LabourRow.svelte';
	import XpBar from '#lib/components/XpBar.svelte';
	import { applyToHome } from '#lib/live/apply.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import type { HomeView } from '#lib/live/types.ts';
	import { lookFor, usersOf } from '#lib/ui/directory.ts';
	import { byRecent } from '#lib/ui/lookup.ts';
	import { directory } from '#lib/ui/people.ts';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const user = $derived(data.user!);
	// svelte-ignore state_referenced_locally
	const live = new LiveView<HomeView>(data.seq, data.home, applyToHome(data.user!.id));
	$effect(() => live.load(data.home, data.seq));

	const home = $derived(live.current!);
	const people = $derived(directory(data.people));
	const mine = $derived([...home.mine].sort(byRecent));
	$effect(() => lookFor(usersOf(home.mine), people));
	let creating = $state(false);
</script>

<svelte:head>
	<title>sagas</title>
</svelte:head>

<main class="mx-auto grid max-w-6xl gap-8 px-4 pt-4 pb-16">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-4xl font-extrabold tracking-tight">Hello, {user.displayName}</h1>
			<p class="mt-1 text-sm text-muted">
				Signed in as {user.displayName} (@{user.username})
			</p>
		</div>
		<form method="POST" action="/logout">
			<button type="submit" class="btn btn-quiet">Sign out</button>
		</form>
	</div>

	<section aria-labelledby="realms-heading" class="grid gap-3">
		<div class="flex items-center justify-between gap-3">
			<h2 id="realms-heading" class="text-xl font-bold tracking-tight">Realms</h2>
			<button
				type="button"
				class="btn"
				aria-expanded={creating}
				aria-controls="new-realm"
				onclick={() => (creating = !creating)}>New Realm</button
			>
		</div>
		{#if creating || form?.scope === 'createRealm'}
			<form
				id="new-realm"
				method="POST"
				action="?/createRealm"
				use:enhance
				class="panel flex flex-wrap items-end gap-3 p-4"
			>
				<label class="grid gap-1">
					<span class="label">Name</span>
					<input name="name" required maxlength="120" class="field w-64 max-w-full" />
				</label>
				<label class="grid gap-1">
					<span class="label">Key</span>
					<input
						name="key"
						required
						pattern="[A-Za-z][A-Za-z0-9]{'{1,5}'}"
						maxlength="6"
						class="field w-28 font-mono uppercase"
						aria-describedby="key-help"
					/>
				</label>
				<button type="submit" class="btn btn-primary">Create Realm</button>
				<p id="key-help" class="w-full text-xs text-muted">
					2 to 6 letters or digits, starting with a letter. Labours are numbered under it, like
					AM-12.
				</p>
				{#if form?.scope === 'createRealm' && form.error}
					<p role="alert" class="error w-full">{form.error}</p>
				{/if}
			</form>
		{/if}
		{#if home.realms.length === 0}
			<p class="panel p-6 text-muted">
				No Realms yet. Create one to get a board with To do, In progress and Closed.
			</p>
		{:else}
			<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each home.realms as realm (realm.id)}
					<li>
						<a
							href={resolve('/r/[key]', { key: realm.key })}
							class="panel group flex h-full flex-col gap-3 p-4 transition-colors hover:border-ink/40"
						>
							<span class="flex items-baseline justify-between gap-2">
								<span class="truncate text-lg font-bold tracking-tight group-hover:underline"
									>{realm.name}</span
								>
								<span class="key">{realm.key}</span>
							</span>
							<span class="flex flex-wrap gap-1" aria-label="States">
								{#each realm.states as state (state.id)}
									<StatePill def={state} variant="dot" />
								{/each}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<div class="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
		<section aria-labelledby="mine-heading" class="grid gap-3">
			<h2 id="mine-heading" class="text-xl font-bold tracking-tight">Your open Labours</h2>
			{#if mine.length === 0}
				<p class="panel p-6 text-muted">
					Nothing open is yours. Labours you own or are assigned show up here.
				</p>
			{:else}
				<ul class="panel max-h-[52rem] divide-y divide-line overflow-y-auto" data-testid="mine">
					{#each mine as labour (labour.id)}
						<li><LabourRow {labour} realms={home.realms} {people} /></li>
					{/each}
				</ul>
			{/if}
		</section>

		<section aria-labelledby="quests-heading" class="grid gap-3">
			<div class="flex items-center justify-between gap-3">
				<h2 id="quests-heading" class="text-xl font-bold tracking-tight">Your Quests</h2>
				<a href={resolve('/quests')} class="btn btn-quiet">All Quests</a>
			</div>
			{#if home.quests.length === 0}
				<p class="panel p-6 text-muted">You own no Quests yet.</p>
			{:else}
				<ul class="grid gap-3">
					{#each home.quests as quest (quest.id)}
						<li class="panel p-4">
							<a
								href={resolve('/quests/[id]', { id: String(quest.id) })}
								class="mb-2 block font-bold tracking-tight hover:underline">{quest.name}</a
							>
							<XpBar closed={quest.progress.closed} total={quest.progress.total} />
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</main>
