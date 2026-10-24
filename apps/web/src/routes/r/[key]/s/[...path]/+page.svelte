<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ScrollPage from '#lib/components/scroll/ScrollPage.svelte';
	import ScrollTree from '#lib/components/scroll/ScrollTree.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	{#if !data.page && data.missing}
		<title>No Scroll · {data.missing.realm.name} · sagas</title>
	{/if}
</svelte:head>

{#if data.page}
	{#key data.page.scroll.id}
		<ScrollPage page={data.page} seq={data.seq} />
	{/key}
{:else if data.missing}
	{@const missing = data.missing}
	<main
		class="mx-auto grid max-w-6xl items-start gap-6 px-4 pt-2 pb-16 lg:grid-cols-[16rem_minmax(0,1fr)]"
	>
		<ScrollTree realm={missing.realm} tree={missing.tree} current={missing.path} />
		<section class="panel grid gap-3 p-5" data-testid="missing-scroll">
			<h1 class="text-2xl font-extrabold tracking-tight">No Scroll here yet</h1>
			<p class="text-sm text-muted">
				Nothing in {missing.realm.name} has the path <span class="font-mono">{missing.path}</span>.
			</p>
			{#if missing.canEdit}
				<form method="POST" action="?/create" use:enhance class="grid gap-3">
					<input type="hidden" name="slug" value={missing.slug} />
					{#if missing.parent}<input type="hidden" name="parentId" value={missing.parent.id} />{/if}
					<label class="grid gap-1 text-sm">
						<span class="label">Title</span>
						<input class="field" name="title" maxlength="120" required value={missing.title} />
					</label>
					<p class="text-xs text-muted">
						{#if missing.parent}
							It goes under
							<a
								class="underline"
								href={resolve('/r/[key]/s/[...path]', {
									key: missing.realm.key,
									path: missing.parent.path
								})}>{missing.parent.title}</a
							>.
						{:else}
							It goes at the top level.
						{/if}
					</p>
					<div><button class="btn btn-primary" type="submit">Create this Scroll</button></div>
					{#if form?.scope === 'create' && 'error' in form}
						<p role="alert" class="error">{form.error}</p>
					{/if}
				</form>
			{/if}
		</section>
	</main>
{/if}
