<script lang="ts">
	import './layout.css';
	import AppHeader from '#lib/components/AppHeader.svelte';
	import Notices from '#lib/components/Notices.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>

<a
	href="#main"
	class="sr-only z-50 rounded-lg bg-panel px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
	>Skip to content</a
>
{#if data.user}
	<AppHeader user={data.user} />
{/if}
<div id="main" class="min-w-0">
	{@render children()}
</div>
<Notices />
