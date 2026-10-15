<script lang="ts">
	import TicketPage from '#lib/components/ticket/TicketPage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- One page per Ticket: drafts, errors and pending writes never follow a link to another. -->
{#key data.page.ticket.id}
	<TicketPage seq={data.seq} page={data.page} me={data.user!} people={data.people} />
{/key}
