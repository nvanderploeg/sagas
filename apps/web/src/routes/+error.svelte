<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · sagas</title>
</svelte:head>

<main class="mx-auto max-w-xl px-4 py-16">
	<div class="panel p-8">
		<p class="key">{page.status}</p>
		<h1 class="mt-1 text-2xl font-bold tracking-tight">{page.error?.message ?? 'Not found'}</h1>
		<a class="btn mt-5" href={resolve('/')}>Go home</a>
	</div>
</main>
