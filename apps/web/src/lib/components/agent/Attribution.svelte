<script lang="ts">
	import type { Person } from '#lib/ui/people.ts';
	import { stamp } from '#lib/ui/time.ts';
	import Stale from './Stale.svelte';

	let {
		people,
		by,
		at,
		stale = false
	}: { people: Map<number, Person>; by: number; at: string; stale?: boolean } = $props();
</script>

<span class="text-xs text-muted"
	>{people.get(by)?.displayName ?? 'Someone'} · <time datetime={at}>{stamp(at)}</time></span
>
{#if stale}<Stale />{/if}
