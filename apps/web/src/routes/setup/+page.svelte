<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Set up workload</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<p class="mb-6 inline-flex items-center gap-2 font-mono font-semibold">
		<span class="size-2.5 rounded-full bg-[#22c55e]" aria-hidden="true"></span>workload
	</p>
	<h1 class="text-3xl font-extrabold tracking-tight">Set up workload</h1>
	{#if form?.token}
		<p class="mt-2 text-sm">
			The first Admin is ready. This is its API token, for the MCP server and other clients. Copy it
			now: it is shown only once.
		</p>
		<code
			class="mt-4 block rounded-lg border border-line bg-panel-2 px-2 py-1.5 font-mono text-sm break-all"
			>{form.token}</code
		>
		<a href={resolve('/')} class="btn btn-primary mt-6">Continue</a>
	{:else}
		<p class="mt-2 text-sm">Create the first Admin.</p>

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
				Display name
				<input name="displayName" required value={form?.displayName ?? ''} class="field" />
			</label>
			<label class="grid gap-1 text-sm font-medium text-muted">
				Password (7 to 256 characters)
				<input
					type="password"
					name="password"
					required
					minlength="7"
					maxlength="256"
					autocomplete="new-password"
					class="field"
				/>
			</label>
			{#if form?.error}
				<p role="alert" class="error">{form.error}</p>
			{/if}
			<button type="submit" class="btn btn-primary">Create Admin</button>
		</form>
	{/if}
</main>
