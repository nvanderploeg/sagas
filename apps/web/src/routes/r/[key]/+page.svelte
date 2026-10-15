<script lang="ts">
	import Board from '#lib/components/board/Board.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.board.realm.name} · sagas</title>
</svelte:head>

{#key data.board.realm.id}
	<Board seq={data.seq} board={data.board} me={data.user!} people={data.people} />
{/key}
