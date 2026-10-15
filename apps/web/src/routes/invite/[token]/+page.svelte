<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Join sagas</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<p class="mb-6 inline-flex items-center gap-2 font-mono font-semibold">
		<span class="size-2.5 rounded-full bg-[#22c55e]" aria-hidden="true"></span>sagas
	</p>
	<h1 class="text-3xl font-extrabold tracking-tight">Join sagas</h1>

	{#if data.open}
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
			<button type="submit" class="btn btn-primary">Join</button>
		</form>
	{:else}
		<p class="mt-6 text-sm">This invite is invalid or has already been used.</p>
	{/if}
</main>
