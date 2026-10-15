<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Sign in · workload</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<p class="mb-6 inline-flex items-center gap-2 font-mono font-semibold">
		<span class="size-2.5 rounded-full bg-[#22c55e]" aria-hidden="true"></span>workload
	</p>
	<h1 class="text-3xl font-extrabold tracking-tight">Sign in</h1>

	<form method="POST" class="panel mt-6 grid gap-4 p-5">
		<label class="grid gap-1 text-sm font-medium text-muted">
			Username
			<input
				name="username"
				required
				autocomplete="username"
				value={form?.username ?? ''}
				class="field"
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium text-muted">
			Password
			<input
				type="password"
				name="password"
				required
				autocomplete="current-password"
				class="field"
			/>
		</label>
		{#if form?.error}
			<p role="alert" class="error">{form.error}</p>
		{/if}
		<button type="submit" class="btn btn-primary">Sign in</button>
	</form>
</main>
