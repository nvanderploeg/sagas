<script lang="ts">
	import { resolve } from '$app/paths';
	import Avatar from '#lib/components/Avatar.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import Tokens from '#lib/components/Tokens.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const user = $derived(data.user!);
	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;
</script>

<svelte:head>
	<title>Account · sagas</title>
</svelte:head>

<main class="mx-auto grid max-w-3xl gap-6 px-4 pt-4 pb-16">
	<div class="flex flex-wrap items-center gap-4">
		<Avatar person={user} size="md" />
		<div class="min-w-0 flex-1">
			<h1 class="text-3xl font-extrabold tracking-tight">{user.displayName}</h1>
			<p class="key">@{user.username}{user.isAdmin ? ' · Admin' : ''}</p>
		</div>
		<form method="POST" action="/logout">
			<button type="submit" class="btn">Sign out</button>
		</form>
	</div>

	<section class="panel grid gap-3 p-5" aria-labelledby="tokens-heading">
		<h2 id="tokens-heading" class="text-lg font-bold tracking-tight">Your API tokens</h2>
		<p class="text-sm text-muted">
			A token lets a client such as the MCP server act as you, without a browser session.
		</p>
		<Tokens
			tokens={data.tokens}
			userId={user.id}
			owner={user.displayName}
			created={form && 'token' in form ? String(form.token) : null}
			error={failure('token') ?? failure('revoke')}
		/>
	</section>

	<section class="panel flex flex-wrap items-center justify-between gap-3 p-5">
		<h2 class="text-lg font-bold tracking-tight">Password</h2>
		<a class="btn" href={resolve('/password')}>Change password</a>
	</section>

	<section class="panel flex flex-wrap items-center justify-between gap-3 p-5">
		<h2 class="text-lg font-bold tracking-tight">Theme</h2>
		<ThemeToggle />
	</section>
</main>
