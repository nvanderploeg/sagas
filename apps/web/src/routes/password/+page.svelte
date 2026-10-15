<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Change password · sagas</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<h1 class="text-3xl font-extrabold tracking-tight">Change password</h1>
	{#if data.required}
		<p class="mt-2 text-sm text-muted">You must choose a new password before you continue.</p>
	{/if}

	<form method="POST" class="panel mt-6 grid gap-4 p-5">
		<label class="grid gap-1 text-sm font-medium text-muted">
			Current password
			<input
				type="password"
				name="current"
				required
				autocomplete="current-password"
				class="field"
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium text-muted">
			New password
			<input type="password" name="next" required autocomplete="new-password" class="field" />
		</label>
		<label class="grid gap-1 text-sm font-medium text-muted">
			Confirm new password
			<input type="password" name="confirm" required autocomplete="new-password" class="field" />
		</label>
		{#if form?.error}
			<p role="alert" class="error">{form.error}</p>
		{/if}
		<button type="submit" class="btn btn-primary">Change password</button>
	</form>
</main>
