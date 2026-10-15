<script lang="ts">
	import { renderMarkdown } from '../ui/markdown.ts';

	let { source, empty = 'No description.' }: { source: string; empty?: string } = $props();

	const html = $derived(renderMarkdown(source));
</script>

{#if source.trim() === ''}
	<p class="text-sm text-muted italic">{empty}</p>
{:else}
	<div class="prose-workload prose max-w-none" data-testid="markdown">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown escapes raw HTML -->
		{@html html}
	</div>
{/if}
