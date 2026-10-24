<script lang="ts">
	import { resolve } from '$app/paths';

	type Node = { id: number; parentId: number | null; path: string; title: string; depth: number };

	let {
		realm,
		tree,
		current = null,
		query = ''
	}: {
		realm: { key: string; name: string };
		tree: Node[];
		current?: string | null;
		query?: string;
	} = $props();

	const shown = $derived.by(() => {
		const open = tree
			.filter(
				(node) => current !== null && (current === node.path || current.startsWith(`${node.path}/`))
			)
			.map((node) => node.id);
		return tree.filter((node) => node.parentId === null || open.includes(node.parentId));
	});
</script>

<nav class="panel grid gap-3 p-4" aria-label="Scrolls of {realm.name}">
	<div class="flex items-baseline justify-between gap-2">
		<a
			class="font-bold tracking-tight hover:underline"
			href={resolve('/r/[key]/s', { key: realm.key })}>Scrolls</a
		>
		<a class="text-xs text-muted hover:text-ink" href={resolve('/r/[key]', { key: realm.key })}
			>{realm.key} board</a
		>
	</div>
	<form method="GET" action={resolve('/r/[key]/s', { key: realm.key })} role="search">
		<label class="sr-only" for="scroll-search">Search Scrolls</label>
		<input
			id="scroll-search"
			class="field w-full"
			type="search"
			name="q"
			placeholder="Search Scrolls"
			value={query}
		/>
	</form>
	{#if tree.length === 0}
		<p class="text-sm text-muted">No Scrolls yet.</p>
	{:else}
		<ul class="grid gap-0.5 text-sm" data-testid="scroll-tree">
			{#each shown as node (node.id)}
				<li style:padding-left="{node.depth * 0.9}rem">
					<a
						class="block truncate rounded px-2 py-1 hover:bg-panel-2"
						class:active={node.path === current}
						aria-current={node.path === current ? 'page' : undefined}
						href={resolve('/r/[key]/s/[...path]', { key: realm.key, path: node.path })}
						>{node.title}</a
					>
				</li>
			{/each}
		</ul>
	{/if}
</nav>

<style>
	.active {
		background: var(--color-panel-2);
		font-weight: 700;
	}
</style>
