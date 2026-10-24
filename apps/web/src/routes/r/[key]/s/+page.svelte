<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ScrollList from '#lib/components/scroll/ScrollList.svelte';
	import ScrollTree from '#lib/components/scroll/ScrollTree.svelte';
	import { applyToScrollView } from '#lib/live/scrolls.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { act } from '#lib/ui/act.ts';
	import { encodePlacement } from '#lib/ui/board.ts';
	import { notices } from '#lib/ui/notices.svelte.ts';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type View = PageData['page'];

	// svelte-ignore state_referenced_locally
	const live = new LiveView<View>(data.seq, data.page, applyToScrollView);
	$effect(() => live.load(data.page, data.seq));
	const view = $derived(live.current);

	$effect(() => {
		if (live.ended) {
			notices.show('This Realm was deleted.');
			goto(resolve('/'));
		}
	});

	async function rank(
		id: number,
		placement: Parameters<typeof encodePlacement>[0],
		order: View['top']
	) {
		try {
			await live.mutate(
				(v) => ({ ...v, top: order }),
				() => act('rank', { scrollId: id, placement: encodePlacement(placement) })
			);
		} catch (error) {
			notices.error(error);
		}
	}
</script>

<svelte:head>
	<title>Scrolls · {view?.realm.name ?? 'Realm'} · sagas</title>
</svelte:head>

{#if view}
	<main
		class="mx-auto grid max-w-6xl items-start gap-6 px-4 pt-2 pb-16 lg:grid-cols-[16rem_minmax(0,1fr)]"
	>
		<ScrollTree realm={view.realm} tree={view.tree} query={view.query} />

		<div class="grid min-w-0 gap-6">
			<header class="panel grid gap-1 p-5">
				<p class="text-sm text-muted">
					<span class="key">{view.realm.key}</span>
					{view.realm.name}
				</p>
				<h1 class="text-3xl font-extrabold tracking-tight">Scrolls</h1>
			</header>

			{#if view.hits !== null}
				<section class="panel grid gap-3 p-5" aria-labelledby="hits-heading">
					<h2 id="hits-heading" class="font-bold tracking-tight">
						Matches for “{view.query}”
					</h2>
					{#if view.hits.length === 0}
						<p class="text-sm text-muted">No Scroll matches.</p>
					{:else}
						<ul class="grid gap-3" data-testid="scroll-hits">
							{#each view.hits as hit (hit.id)}
								<li>
									<a
										class="font-semibold hover:underline"
										href={resolve('/r/[key]/s/[...path]', { key: view.realm.key, path: hit.path })}
										>{hit.title}</a
									>
									<span class="text-xs text-muted">{hit.path}</span>
									{#if hit.snippet}<p class="text-sm text-muted">{hit.snippet}</p>{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}

			<section class="panel overflow-hidden" aria-labelledby="top-heading">
				<div class="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
					<h2 id="top-heading" class="font-bold tracking-tight">Top-level Scrolls</h2>
					{#if view.canEdit && view.top.length > 1}
						<p class="text-xs text-muted">Drag ⠿ to reorder, or focus it and press Space.</p>
					{/if}
				</div>
				{#if view.top.length === 0}
					<p class="px-5 pb-5 text-sm text-muted">
						{view.canEdit
							? 'No Scrolls yet. Start the wiki with the form below.'
							: 'No Scrolls yet.'}
					</p>
				{:else}
					<ScrollList
						realmKey={view.realm.key}
						items={view.top}
						canEdit={view.canEdit}
						label="Top-level Scrolls"
						onrank={rank}
					/>
				{/if}
			</section>

			{#if view.canEdit}
				<form method="POST" action="?/create" use:enhance class="panel grid gap-3 p-5">
					<h2 class="font-bold tracking-tight">New Scroll</h2>
					<label class="grid gap-1 text-sm">
						<span class="label">Title</span>
						<input class="field" name="title" maxlength="120" required />
					</label>
					<div><button class="btn btn-primary" type="submit">Create Scroll</button></div>
					{#if form?.scope === 'create' && 'error' in form}
						<p role="alert" class="error">{form.error}</p>
					{/if}
				</form>
			{/if}
		</div>
	</main>
{/if}
