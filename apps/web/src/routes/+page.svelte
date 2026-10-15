<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>workload</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-16">
	<h1 class="text-3xl font-semibold tracking-tight">workload</h1>
	<p class="mt-4 text-sm">Signed in as {data.user.displayName} (@{data.user.username}).</p>
	<form method="POST" action="/logout" class="mt-4">
		<button type="submit" class="rounded border px-3 py-1 text-sm">Sign out</button>
	</form>
</main>
