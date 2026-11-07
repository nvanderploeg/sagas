<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { returnPath } from '#lib/ui/return-path.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state('');
	let sent = $state(false);
	let busy = $state(false);
	let error = $state('');
	let confirmingLink = $state(false);

	const next = $derived(returnPath(page.url.searchParams.get('next')));

	async function run(work: () => Promise<void>) {
		busy = true;
		error = '';
		try {
			await work();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			busy = false;
		}
	}

	async function finish() {
		location.assign(next);
	}

	async function google() {
		const firebase = await import('#lib/ui/firebase.ts');
		await run(async () => {
			await firebase.signInWithGoogle(data.firebase);
			await finish();
		});
	}

	async function sendLink(event: SubmitEvent) {
		event.preventDefault();
		const firebase = await import('#lib/ui/firebase.ts');
		await run(async () => {
			await firebase.emailSignInLink(data.firebase, email.trim());
			sent = true;
		});
	}

	async function completeLink(event?: SubmitEvent) {
		event?.preventDefault();
		const firebase = await import('#lib/ui/firebase.ts');
		await run(async () => {
			await firebase.completeEmailLink(data.firebase, email.trim());
			await finish();
		});
	}

	onMount(async () => {
		const firebase = await import('#lib/ui/firebase.ts');
		if (!firebase.arrivedByEmailLink(data.firebase)) return;
		email = firebase.rememberedEmail();
		if (email) await completeLink();
		else confirmingLink = true;
	});
</script>

<svelte:head>
	<title>Sign in · sagas</title>
</svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<p class="mb-6 inline-flex items-center gap-2 font-mono font-semibold">
		<span class="size-2.5 rounded-full bg-[#22c55e]" aria-hidden="true"></span>sagas
	</p>
	<h1 class="text-3xl font-extrabold tracking-tight">Sign in</h1>

	<div class="panel mt-6 grid gap-4 p-5">
		{#if confirmingLink}
			<form class="grid gap-4" onsubmit={completeLink}>
				<label class="grid gap-1 text-sm font-medium text-muted">
					Confirm your email to finish signing in
					<input
						type="email"
						name="email"
						required
						autocomplete="email"
						bind:value={email}
						class="field"
					/>
				</label>
				<button type="submit" class="btn btn-primary" disabled={busy}>Finish signing in</button>
			</form>
		{:else}
			<button type="button" class="btn btn-primary" disabled={busy} onclick={google}>
				Continue with Google
			</button>
			<form class="grid gap-3" onsubmit={sendLink}>
				<label class="grid gap-1 text-sm font-medium text-muted">
					Or get a sign-in link by email
					<input
						type="email"
						name="email"
						required
						autocomplete="email"
						bind:value={email}
						class="field"
					/>
				</label>
				<button type="submit" class="btn" disabled={busy}>Email me a link</button>
			</form>
			{#if sent}
				<p role="status" class="text-sm text-muted">
					Check your inbox for the link, then open it in this browser.
				</p>
			{/if}
		{/if}
		{#if error}
			<p role="alert" class="error">{error}</p>
		{/if}
	</div>
</main>
