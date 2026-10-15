<script lang="ts">
	import { enhance } from '$app/forms';
	import Avatar from '#lib/components/Avatar.svelte';
	import Secret from '#lib/components/Secret.svelte';
	import Tokens from '#lib/components/Tokens.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;
	const link = $derived(form && 'link' in form ? String(form.link) : null);
	const created = $derived(
		form && 'token' in form ? { userId: Number(form.userId), token: String(form.token) } : null
	);
	const name = (id: number | null) => data.users.find((u) => u.id === id)?.displayName ?? 'someone';
	const day = (date: Date) => new Date(date).toISOString().slice(0, 10);
	const agents = $derived(data.users.filter((u) => u.kind === 'agent'));
</script>

<svelte:head>
	<title>Admin · sagas</title>
</svelte:head>

<main class="mx-auto grid max-w-4xl gap-6 px-4 pt-4 pb-16">
	<h1 class="text-4xl font-extrabold tracking-tight">Admin</h1>

	<section class="panel overflow-hidden" aria-labelledby="users-heading">
		<h2 id="users-heading" class="px-5 pt-4 pb-2 text-lg font-bold tracking-tight">Users</h2>
		<ul class="divide-y divide-line border-t border-line" data-testid="users">
			{#each data.users as user (user.id)}
				<li class="flex flex-wrap items-center gap-3 px-5 py-2.5">
					<Avatar person={user} size="sm" />
					<span class="font-semibold">{user.displayName}</span>
					<span class="key">@{user.username}</span>
					<span class="ml-auto flex gap-1.5 text-xs">
						{#if user.isAdmin}<span class="tag">Admin</span>{/if}
						<span class="tag">{user.kind === 'agent' ? 'Agent' : 'Human'}</span>
					</span>
				</li>
			{/each}
		</ul>
	</section>

	<section class="panel grid gap-3 p-5" aria-labelledby="invites-heading">
		<h2 id="invites-heading" class="text-lg font-bold tracking-tight">Invites</h2>
		<p class="text-sm text-muted">
			An Invite is a single-use link. Whoever opens it picks a username and password and joins.
		</p>
		<form method="POST" action="?/invite" use:enhance>
			<button type="submit" class="btn btn-primary">Create Invite</button>
		</form>
		{#if link}
			<Secret
				value={link}
				label="Invite link"
				note="Copy it now: it is shown only once. Send it to one person."
			/>
		{/if}
		{#if failure('invite')}<p role="alert" class="error">{failure('invite')}</p>{/if}
		{#if data.invites.length > 0}
			<ul class="divide-y divide-line rounded-xl border border-line text-sm">
				{#each [...data.invites].reverse() as invite (invite.id)}
					<li class="flex flex-wrap gap-x-4 px-3 py-2" data-testid="invite">
						<span>Created {day(invite.createdAt)} by {name(invite.createdByUserId)}</span>
						<span class="ml-auto text-muted">
							{invite.usedAt ? `Used by ${name(invite.usedByUserId)}` : 'Open'}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="panel grid gap-4 p-5" aria-labelledby="agents-heading">
		<h2 id="agents-heading" class="text-lg font-bold tracking-tight">Agent users</h2>
		<p class="text-sm text-muted">
			Agents sign in only with API tokens, and can own and be assigned Labours.
		</p>
		<form method="POST" action="?/agent" use:enhance class="flex flex-wrap items-end gap-2">
			<label class="grid gap-1">
				<span class="label">Username</span>
				<input name="username" class="field w-44" required maxlength="32" />
			</label>
			<label class="grid gap-1">
				<span class="label">Display name</span>
				<input name="displayName" class="field w-56" required maxlength="100" />
			</label>
			<button type="submit" class="btn btn-primary">Create Agent user</button>
			{#if failure('agent')}<p role="alert" class="error w-full">{failure('agent')}</p>{/if}
		</form>
		{#each agents as agent (agent.id)}
			<article class="grid gap-3 rounded-xl border border-line p-4" data-testid="agent">
				<h3 class="flex items-center gap-2 font-semibold">
					<Avatar person={agent} size="sm" />
					{agent.displayName} <span class="key">@{agent.username}</span>
				</h3>
				<Tokens
					tokens={data.tokens[agent.id] ?? []}
					userId={agent.id}
					owner={agent.displayName}
					created={created?.userId === agent.id ? created.token : null}
					error={failure(`token:${agent.id}`)}
				/>
			</article>
		{/each}
		{#if failure('revoke')}<p role="alert" class="error">{failure('revoke')}</p>{/if}
	</section>
</main>

<style>
	.tag {
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--color-line);
		border-radius: 999px;
		color: var(--color-muted);
		font-weight: 600;
	}
</style>
