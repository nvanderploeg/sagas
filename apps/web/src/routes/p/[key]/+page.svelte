<script lang="ts">
	import Board from '#lib/components/board/Board.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.board.project.name} · workload</title>
</svelte:head>

{#key data.board.project.id}
	<Board seq={data.seq} board={data.board} me={data.user!} people={data.people} />
{/key}
