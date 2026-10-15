<script lang="ts">
	import LabourPage from '#lib/components/labour/LabourPage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- One page per Labour: drafts, errors and pending writes never follow a link to another. -->
{#key data.page.labour.id}
	<LabourPage seq={data.seq} page={data.page} me={data.user!} people={data.people} />
{/key}
