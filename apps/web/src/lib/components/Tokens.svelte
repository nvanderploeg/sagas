<script lang="ts">
	import { enhance } from '$app/forms';
	import ConfirmButton from './ConfirmButton.svelte';
	import Secret from './Secret.svelte';

	type Token = {
		id: number;
		name: string;
		createdAt: Date;
		lastUsedAt: Date | null;
		revokedAt: Date | null;
	};

	let {
		tokens,
		userId,
		created = null,
		error = null,
		owner
	}: {
		tokens: Token[];
		userId: number;
		created?: string | null;
		error?: string | null;
		owner: string;
	} = $props();

	const day = (date: Date | null) => (date ? new Date(date).toISOString().slice(0, 10) : 'never');
</script>

<div class="grid gap-3">
	{#if tokens.length === 0}
		<p class="text-sm text-muted">No API tokens.</p>
	{:else}
		<ul
			class="divide-y divide-line rounded-xl border border-line"
			aria-label="API tokens of {owner}"
		>
			{#each tokens as token (token.id)}
				<li
					class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
					data-testid="token"
				>
					<span class="font-semibold">{token.name}</span>
					<span class="text-xs text-muted">created {day(token.createdAt)}</span>
					<span class="text-xs text-muted">last used {day(token.lastUsedAt)}</span>
					<span class="ml-auto">
						{#if token.revokedAt}
							<span class="text-xs font-semibold text-muted">Revoked {day(token.revokedAt)}</span>
						{:else}
							<form method="POST" action="?/revoke" use:enhance>
								<input type="hidden" name="tokenId" value={token.id} />
								<ConfirmButton type="submit" label="Revoke" confirm="Revoke {token.name}" />
							</form>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if created}
		<Secret
			value={created}
			label="New API token"
			note="Copy it now: it is shown only once. It acts as {owner}."
		/>
	{/if}
	<form method="POST" action="?/token" use:enhance class="flex flex-wrap items-end gap-2">
		<input type="hidden" name="userId" value={userId} />
		<label class="grid gap-1">
			<span class="label">Token name</span>
			<input
				name="name"
				class="field w-56"
				required
				maxlength="100"
				placeholder="e.g. laptop MCP"
			/>
		</label>
		<button type="submit" class="btn">Create token</button>
		{#if error}<p role="alert" class="error w-full">{error}</p>{/if}
	</form>
</div>
