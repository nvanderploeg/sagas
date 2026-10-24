<script lang="ts">
	import { resolve } from '$app/paths';
	import { renderScroll } from '#lib/ui/markdown.ts';

	type Target = { path: string; title: string };

	let {
		source,
		realmKey,
		links,
		empty = 'This Scroll is empty.'
	}: { source: string; realmKey: string; links: Record<string, Target>; empty?: string } = $props();

	const href = (path: string) => resolve('/r/[key]/s/[...path]', { key: realmKey, path });

	const html = $derived(
		renderScroll(source, (target) => {
			const found = links[target];
			return found
				? { href: href(found.path), title: found.title, missing: false }
				: { href: href(target), title: target, missing: true };
		})
	);
</script>

{#if source.trim() === ''}
	<p class="text-sm text-muted italic">{empty}</p>
{:else}
	<div class="prose-sagas prose max-w-none min-w-0" data-testid="scroll-body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderScroll escapes raw HTML -->
		{@html html}
	</div>
{/if}
