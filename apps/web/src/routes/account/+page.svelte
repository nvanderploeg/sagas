<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import AdvancedToggle from '#lib/components/AdvancedToggle.svelte';
	import UserLayer from '#lib/components/agent/UserLayer.svelte';
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

	{#if data.offers.length > 0}
		<section class="panel grid gap-3 p-5" aria-labelledby="offers-heading" data-testid="offers">
			<h2 id="offers-heading" class="text-lg font-bold tracking-tight">Offers</h2>
			<ul class="divide-y divide-line">
				{#each data.offers as offer (offer.realmId)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
						<span>
							<span class="font-semibold">{offer.realmName}</span>
							<span class="key">{offer.realmKey}</span>
							<span class="text-muted">
								as {offer.role}{offer.invitedByName ? `, from ${offer.invitedByName}` : ''}
							</span>
						</span>
						<span class="flex gap-2">
							<form method="POST" action="?/acceptOffer" use:enhance>
								<input type="hidden" name="realmId" value={offer.realmId} />
								<button class="btn btn-primary" type="submit">Accept</button>
							</form>
							<form method="POST" action="?/declineOffer" use:enhance>
								<input type="hidden" name="realmId" value={offer.realmId} />
								<button class="btn" type="submit">Decline</button>
							</form>
						</span>
					</li>
				{/each}
			</ul>
			{#if failure('offers')}<p role="alert" class="error">{failure('offers')}</p>{/if}
		</section>
	{/if}

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

	<UserLayer />

	<section class="panel flex flex-wrap items-center justify-between gap-3 p-5">
		<h2 class="text-lg font-bold tracking-tight">Theme</h2>
		<ThemeToggle />
	</section>

	<section class="panel flex flex-wrap items-center justify-between gap-3 p-5">
		<h2 class="text-lg font-bold tracking-tight">Advanced view</h2>
		<AdvancedToggle />
	</section>
</main>
