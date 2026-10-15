<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Set up workload</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<h1 class="text-2xl font-semibold tracking-tight">Set up workload</h1>
	<p class="mt-2 text-sm">Create the first Admin.</p>

	<form method="POST" class="mt-6 grid gap-4">
		<label class="grid gap-1 text-sm">
			Username
			<input
				name="username"
				required
				autocomplete="username"
				value={form?.username ?? ''}
				class="rounded border px-2 py-1"
			/>
		</label>
		<label class="grid gap-1 text-sm">
			Display name
			<input
				name="displayName"
				required
				value={form?.displayName ?? ''}
				class="rounded border px-2 py-1"
			/>
		</label>
		<label class="grid gap-1 text-sm">
			Password (7 to 256 characters)
			<input
				type="password"
				name="password"
				required
				minlength="7"
				maxlength="256"
				autocomplete="new-password"
				class="rounded border px-2 py-1"
			/>
		</label>
		{#if form?.error}
			<p role="alert" class="text-sm text-red-700">{form.error}</p>
		{/if}
		<button type="submit" class="rounded bg-black px-3 py-2 text-sm text-white">Create Admin</button
		>
	</form>
</main>
