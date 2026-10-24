<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page as currentPage } from '$app/state';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import ScrollBody from '#lib/components/scroll/ScrollBody.svelte';
	import ScrollList from '#lib/components/scroll/ScrollList.svelte';
	import ScrollTree from '#lib/components/scroll/ScrollTree.svelte';
	import type { Placement } from '#lib/server/domain/rank.ts';
	import type { readScrollPage } from '#lib/server/ui/scroll-reads.ts';
	import { applyToScrollView, movedTo } from '#lib/live/scrolls.ts';
	import type { Json } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { act } from '#lib/ui/act.ts';
	import { encodePlacement } from '#lib/ui/board.ts';
	import { notices } from '#lib/ui/notices.svelte.ts';
	import { stamp } from '#lib/ui/time.ts';

	type View = Json<ReturnType<typeof readScrollPage>>;
	type Child = View['children'][number];

	let { page, seq }: { page: View; seq: number } = $props();

	const hrefOf = (key: string, path: string | null) =>
		path === null ? resolve('/r/[key]/s', { key }) : resolve('/r/[key]/s/[...path]', { key, path });

	// svelte-ignore state_referenced_locally
	const live = new LiveView<View>(seq, page, applyToScrollView, {
		onEvent(event, before) {
			const path = movedTo(event, before.scroll.id);
			if (path !== null) goto(hrefOf(before.realm.key, path), { replaceState: true });
		}
	});
	$effect(() => live.load(page, seq));
	const view = $derived(live.current);
	// svelte-ignore state_referenced_locally
	const leaveTo = hrefOf(page.realm.key, page.ancestors.at(-1)?.path ?? null);

	$effect(() => {
		if (live.ended) {
			notices.show('This Scroll was deleted.');
			goto(leaveTo);
		}
	});

	type Panel = 'edit' | 'child' | 'move' | 'delete' | null;
	let panel = $state<Panel>(null);
	let error = $state('');

	let draft = $state({ title: '', slug: '', body: '', version: 0 });
	let preview = $state(false);
	let saving = $state(false);
	let bodyField = $state<HTMLTextAreaElement | null>(null);

	async function openEditor() {
		if (!view) return;
		const { title, slug, body, version } = view.scroll;
		draft = { title, slug, body, version };
		preview = false;
		error = '';
		panel = 'edit';
		await tick();
		bodyField?.focus();
	}

	onMount(() => {
		if (!currentPage.url.searchParams.has('edit') || !page.canEdit) return;
		openEditor();
		const url = new URL(currentPage.url.href);
		url.searchParams.delete('edit');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the current page, minus a flag
		replaceState(url, currentPage.state);
	});

	async function save() {
		if (!view || saving) return;
		saving = true;
		error = '';
		try {
			const done = await act('update', {
				scrollId: view.scroll.id,
				title: draft.title,
				slug: draft.slug,
				body: draft.body,
				version: draft.version
			});
			panel = null;
			if (done.path !== view.scroll.path) {
				await goto(hrefOf(view.realm.key, String(done.path)), { replaceState: true });
			}
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = false;
		}
	}

	function onEditorKey(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 's') {
			event.preventDefault();
			save();
		}
	}

	const parents = $derived(
		view
			? view.tree.filter(
					(node) => node.path !== view.scroll.path && !node.path.startsWith(`${view.scroll.path}/`)
				)
			: []
	);
	let moveTo = $state('');

	async function move() {
		if (!view) return;
		error = '';
		try {
			const done = await act('move', { scrollId: view.scroll.id, parentId: moveTo || null });
			panel = null;
			await goto(hrefOf(view.realm.key, String(done.path)), { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function rank(id: number, placement: Placement, order: Child[]) {
		try {
			await live.mutate(
				(v) => ({ ...v, children: order }),
				() => act('rank', { scrollId: id, placement: encodePlacement(placement) })
			);
		} catch (e) {
			notices.error(e);
		}
	}

	let choices = $state<Record<number, 'move' | 'delete'>>({});
	function openDelete() {
		choices = Object.fromEntries((view?.children ?? []).map((child) => [child.id, 'move']));
		error = '';
		panel = 'delete';
	}
	const setAll = (choice: 'move' | 'delete') =>
		(choices = Object.fromEntries(Object.keys(choices).map((id) => [id, choice])));
	const doomedCount = $derived(
		1 +
			(view?.children ?? [])
				.filter((child) => choices[child.id] === 'delete')
				.reduce((sum, child) => sum + 1 + child.descendants, 0)
	);

	const toggle = (next: Panel) => {
		error = '';
		if (next === 'edit') openEditor();
		else if (next === 'delete') openDelete();
		else panel = panel === next ? null : next;
	};
</script>

<svelte:head>
	<title>{view?.scroll.title ?? 'Scroll'} · {view?.realm.name ?? ''} · sagas</title>
</svelte:head>

{#if view}
	{@const scroll = view.scroll}
	{@const key = view.realm.key}
	<main
		class="mx-auto grid max-w-6xl items-start gap-6 px-4 pt-2 pb-16 lg:grid-cols-[16rem_minmax(0,1fr)]"
	>
		<ScrollTree realm={view.realm} tree={view.tree} current={scroll.path} />

		<article class="grid min-w-0 gap-6">
			<header class="panel grid gap-3 p-5">
				<nav aria-label="Breadcrumb" class="flex flex-wrap gap-1 text-sm text-muted">
					<a class="hover:text-ink" href={hrefOf(key, null)}>Scrolls</a>
					{#each view.ancestors as ancestor (ancestor.id)}
						<span aria-hidden="true">/</span>
						<a class="hover:text-ink" href={hrefOf(key, ancestor.path)}>{ancestor.title}</a>
					{/each}
				</nav>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<h1 class="min-w-0 text-3xl font-extrabold tracking-tight [overflow-wrap:anywhere]">
						{scroll.title}
					</h1>
					{#if view.canEdit && panel !== 'edit'}
						<div class="flex flex-wrap gap-2">
							<button class="btn btn-primary" type="button" onclick={() => toggle('edit')}
								>Edit</button
							>
							<button class="btn" type="button" onclick={() => toggle('child')}
								>New page here</button
							>
							<button class="btn" type="button" onclick={() => toggle('move')}>Move</button>
							<button class="btn btn-quiet" type="button" onclick={() => toggle('delete')}
								>Delete</button
							>
						</div>
					{/if}
				</div>
				<p class="text-xs text-muted">
					<span class="font-mono">{scroll.path}</span> · Edited by {view.updatedBy}, {stamp(
						scroll.updatedAt
					)}
					· version {scroll.version}
				</p>
			</header>

			{#if panel === 'child'}
				<form
					method="POST"
					action="?/create"
					use:enhance={() =>
						async ({ result, update }) => {
							if (result.type === 'failure')
								error = String(result.data?.error ?? 'That did not work.');
							await update();
						}}
					class="panel grid gap-3 p-5"
				>
					<h2 class="font-bold tracking-tight">New page under {scroll.title}</h2>
					<input type="hidden" name="parentId" value={scroll.id} />
					<label class="grid gap-1 text-sm">
						<span class="label">Title</span>
						<!-- svelte-ignore a11y_autofocus -->
						<input class="field" name="title" maxlength="120" required autofocus />
					</label>
					<div class="flex gap-2">
						<button class="btn btn-primary" type="submit">Create</button>
						<button class="btn btn-quiet" type="button" onclick={() => (panel = null)}
							>Cancel</button
						>
					</div>
				</form>
			{:else if panel === 'move'}
				<form
					class="panel grid gap-3 p-5"
					onsubmit={(e) => {
						e.preventDefault();
						move();
					}}
				>
					<h2 class="font-bold tracking-tight">Move {scroll.title}</h2>
					<label class="grid gap-1 text-sm">
						<span class="label">Put it under</span>
						<select class="field" bind:value={moveTo} data-testid="move-parent">
							<option value="">Top level</option>
							{#each parents as node (node.id)}
								<option value={String(node.id)}
									>{'— '.repeat(node.depth)}{node.title} ({node.path})</option
								>
							{/each}
						</select>
					</label>
					<p class="text-xs text-muted">
						Everything under it moves too. Old addresses keep working.
					</p>
					<div class="flex gap-2">
						<button class="btn btn-primary" type="submit">Move</button>
						<button class="btn btn-quiet" type="button" onclick={() => (panel = null)}
							>Cancel</button
						>
					</div>
				</form>
			{:else if panel === 'delete'}
				<form
					method="POST"
					action="?/delete"
					use:enhance
					class="panel grid gap-3 p-5"
					data-testid="delete-panel"
				>
					<h2 class="font-bold tracking-tight">Delete {scroll.title}</h2>
					<input type="hidden" name="scrollId" value={scroll.id} />
					{#if view.children.length > 0}
						<p class="text-sm">
							It has {view.children.length}
							{view.children.length === 1 ? 'page' : 'pages'} under it. Choose for each: move it up to
							{view.ancestors.at(-1)?.title ?? 'the top level'}, or delete it with everything under
							it.
						</p>
						<div class="flex gap-2">
							<button class="btn" type="button" onclick={() => setAll('move')}>Move all up</button>
							<button class="btn" type="button" onclick={() => setAll('delete')}>Delete all</button>
						</div>
						<ul class="divide-y divide-line rounded-lg border border-line">
							{#each view.children as child (child.id)}
								<li class="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
									<span class="min-w-0">
										<span class="font-semibold">{child.title}</span>
										{#if child.descendants > 0}
											<span class="text-xs text-muted">and {child.descendants} under it</span>
										{/if}
									</span>
									<span class="flex gap-3 text-sm" role="radiogroup" aria-label={child.title}>
										<label class="flex items-center gap-1">
											<input
												type="radio"
												name="choice-{child.id}"
												value="move"
												bind:group={choices[child.id]}
											/>
											Move up
										</label>
										<label class="flex items-center gap-1">
											<input
												type="radio"
												name="choice-{child.id}"
												value="delete"
												bind:group={choices[child.id]}
											/>
											Delete
										</label>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="flex flex-wrap items-center gap-2">
						<ConfirmButton
							type="submit"
							label="Delete {doomedCount === 1 ? 'this Scroll' : `${doomedCount} Scrolls`}"
							confirm="Delete for good"
						/>
						<button class="btn btn-quiet" type="button" onclick={() => (panel = null)}
							>Cancel</button
						>
					</div>
					<p class="text-xs text-muted">
						There is no undo. Links to deleted pages will offer to create them.
					</p>
				</form>
			{/if}

			{#if error}<p role="alert" class="error">{error}</p>{/if}

			{#if panel === 'edit'}
				<form
					class="panel grid gap-3 p-5"
					onsubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
						<label class="grid gap-1 text-sm">
							<span class="label">Title</span>
							<input class="field" maxlength="120" required bind:value={draft.title} />
						</label>
						<label class="grid gap-1 text-sm">
							<span class="label">Slug</span>
							<input class="field font-mono" maxlength="64" required bind:value={draft.slug} />
						</label>
					</div>
					<div class="flex gap-1" role="tablist" aria-label="Editor">
						<button
							type="button"
							role="tab"
							class="btn btn-quiet"
							aria-selected={!preview}
							onclick={() => (preview = false)}>Write</button
						>
						<button
							type="button"
							role="tab"
							class="btn btn-quiet"
							aria-selected={preview}
							onclick={() => (preview = true)}>Preview</button
						>
					</div>
					{#if preview}
						<div class="min-h-48 rounded-lg border border-line p-4">
							<ScrollBody
								source={draft.body}
								realmKey={key}
								links={view.links}
								empty="Nothing to preview."
							/>
						</div>
					{:else}
						<textarea
							class="field min-h-96 w-full font-mono text-sm"
							aria-label="Body (Markdown)"
							maxlength="100000"
							bind:this={bodyField}
							bind:value={draft.body}
							onkeydown={onEditorKey}></textarea>
						<p class="text-xs text-muted">
							Markdown. Link a Scroll with <code>[[path]]</code> or <code>[[path|label]]</code>.
						</p>
					{/if}
					<div class="flex gap-2">
						<button class="btn btn-primary" type="submit" disabled={saving}>Save</button>
						<button class="btn btn-quiet" type="button" onclick={() => (panel = null)}
							>Cancel</button
						>
					</div>
				</form>
			{:else}
				<section class="panel p-5">
					<ScrollBody source={scroll.body} realmKey={key} links={view.links} />
				</section>
			{/if}

			{#if view.children.length > 0}
				<section class="panel overflow-hidden" aria-labelledby="children-heading">
					<h2 id="children-heading" class="px-5 pt-4 pb-2 font-bold tracking-tight">
						Pages under it
					</h2>
					<ScrollList
						realmKey={key}
						items={view.children}
						canEdit={view.canEdit}
						label="Pages under {scroll.title}"
						onrank={rank}
					/>
				</section>
			{/if}

			{#if view.backlinks.length > 0}
				<section class="panel grid gap-2 p-5" aria-labelledby="backlinks-heading">
					<h2 id="backlinks-heading" class="font-bold tracking-tight">Linked from</h2>
					<ul class="grid gap-1 text-sm" data-testid="backlinks">
						{#each view.backlinks as link (link.id)}
							<li><a class="hover:underline" href={hrefOf(key, link.path)}>{link.title}</a></li>
						{/each}
					</ul>
				</section>
			{/if}
		</article>
	</main>
{/if}

<style>
	[role='tab'][aria-selected='true'] {
		background: var(--color-panel-2);
	}
</style>
