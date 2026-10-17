<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Authorize · sagas</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<p class="mb-6 inline-flex items-center gap-2 font-mono font-semibold">
		<span class="size-2.5 rounded-full bg-[#22c55e]" aria-hidden="true"></span>sagas
	</p>
	<h1 class="text-3xl font-extrabold tracking-tight">Connect {data.clientName}?</h1>
	<p class="mt-2 text-sm text-muted">
		The app chose this name itself. Allowing sends you back to {data.redirectHost}.
	</p>

	<form method="POST" class="panel mt-6 grid gap-4 p-5">
		<p class="text-sm">
			It will act as <strong>{data.user.displayName}</strong>
			<span class="key">@{data.user.username}</span> with full access to sagas: everything you can do
			here.
		</p>
		<div class="grid grid-cols-2 gap-3">
			<button type="submit" name="decision" value="deny" class="btn">Deny</button>
			<button type="submit" name="decision" value="allow" class="btn btn-primary">Allow</button>
		</div>
	</form>
</main>
