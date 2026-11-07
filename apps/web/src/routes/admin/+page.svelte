<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import Avatar from '#lib/components/Avatar.svelte';
	import Tokens from '#lib/components/Tokens.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;
	const created = $derived(
		form && 'token' in form ? { userId: Number(form.userId), token: String(form.token) } : null
	);
	const bytes = (n: number) => {
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
		let value = n;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit += 1;
		}
		return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
	};

	let bundle = $state<File | null>(null);
	let confirmation = $state('');
	let uploading = $state(false);
	let importError = $state<string | null>(null);
	let imported = $state(false);
	let progress = $state(0);

	const CHUNK = 256 * 1024;

	async function upload(event: SubmitEvent) {
		event.preventDefault();
		if (!bundle || confirmation !== data.importConfirmation) return;
		uploading = true;
		importError = null;
		progress = 0;
		const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
			b.toString(16).padStart(2, '0')
		).join('');
		try {
			for (let offset = 0; offset < bundle.size || offset === 0; offset += CHUNK) {
				const end = Math.min(offset + CHUNK, bundle.size);
				const response = await fetch(
					`/admin/import?id=${id}&offset=${offset}${end >= bundle.size ? '&final=1' : ''}`,
					{
						method: 'POST',
						headers: {
							accept: 'application/json',
							'content-type': 'application/zip',
							'x-sagas-confirm': confirmation
						},
						body: bundle.slice(offset, end)
					}
				);
				if (!response.ok) {
					const body = await response.json().catch(() => null);
					importError = body?.message ?? `The import failed (${response.status})`;
					return;
				}
				progress = end / Math.max(bundle.size, 1);
				if (end >= bundle.size) break;
			}
			imported = true;
		} catch {
			importError = 'The upload did not finish. Check the connection and try again.';
		} finally {
			uploading = false;
		}
	}

	let stats = $state<{
		appVersion: string;
		databaseBytes: number;
		tables: { name: string; rows: number }[];
		migrations: { tag: string; date: string }[];
		buildMigrations: number;
	} | null>(null);
	let statsError = $state<string | null>(null);

	async function loadStats() {
		statsError = null;
		try {
			const response = await fetch('/admin/stats', { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(String(response.status));
			stats = await response.json();
		} catch {
			statsError = 'Could not load the stats.';
		}
	}

	onMount(loadStats);

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
					<div class="flex basis-full flex-wrap items-end gap-3 text-sm">
						<form method="POST" action="?/realmLimit" use:enhance class="flex items-end gap-2">
							<input type="hidden" name="userId" value={user.id} />
							<label class="grid gap-1 text-xs font-medium text-muted">
								Realm limit
								<input
									type="number"
									name="limit"
									min="0"
									step="1"
									required
									value={user.realmLimit}
									class="field w-24"
								/>
							</label>
							<button type="submit" class="btn">Set</button>
						</form>
						{#if user.kind === 'human'}
							<form method="POST" action="?/email" use:enhance class="flex items-end gap-2">
								<input type="hidden" name="userId" value={user.id} />
								<label class="grid gap-1 text-xs font-medium text-muted">
									Email
									<input
										type="email"
										name="email"
										value={user.email ?? ''}
										autocomplete="off"
										class="field w-64"
									/>
								</label>
								<button type="submit" class="btn">Set</button>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if failure('realmLimit') ?? failure('email')}
			<p role="alert" class="error px-5 pb-3">{failure('realmLimit') ?? failure('email')}</p>
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

	<section class="panel grid gap-3 p-5" aria-labelledby="instance-heading">
		<h2 id="instance-heading" class="text-lg font-bold tracking-tight">Instance</h2>
		{#if stats}
			<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm" data-testid="instance-stats">
				<dt class="text-muted">App version</dt>
				<dd>v{stats.appVersion}</dd>
				<dt class="text-muted">Database size</dt>
				<dd data-testid="database-size">{bytes(stats.databaseBytes)}</dd>
				<dt class="text-muted">Migrations</dt>
				<dd data-testid="migrations">
					{stats.migrations.length} applied of {stats.buildMigrations} in this build
				</dd>
			</dl>
			<details>
				<summary class="cursor-pointer text-sm font-semibold">Rows per table</summary>
				<table class="mt-2 w-full text-sm" data-testid="table-counts">
					<tbody>
						{#each stats.tables as table (table.name)}
							<tr class="border-t border-line">
								<td class="py-1 font-mono">{table.name}</td>
								<td class="py-1 text-right tabular-nums">{table.rows}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
			<details>
				<summary class="cursor-pointer text-sm font-semibold">Applied migrations</summary>
				<ul class="mt-2 text-sm">
					{#each stats.migrations as migration (migration.tag)}
						<li class="flex gap-3 border-t border-line py-1">
							<span class="font-mono">{migration.tag}</span>
							<span class="ml-auto text-muted">{migration.date}</span>
						</li>
					{/each}
				</ul>
			</details>
		{:else if statsError}
			<p role="alert" class="error">{statsError}</p>
		{:else}
			<p class="text-sm text-muted">Loading…</p>
		{/if}
		<div>
			<button type="button" class="btn" onclick={loadStats}>Refresh stats</button>
		</div>
	</section>

	<section class="panel grid gap-3 p-5" aria-labelledby="export-heading">
		<h2 id="export-heading" class="text-lg font-bold tracking-tight">Export</h2>
		<p class="text-sm text-muted">
			Downloads one .zip: a consistent snapshot of the database and a manifest with checksums.
			Webhook secrets stay encrypted; the new host needs the same <code>WEBHOOK_KEY</code>.
		</p>
		<form method="POST" action="/admin/export">
			<button type="submit" class="btn btn-primary">Download export</button>
		</form>
	</section>

	<section class="panel grid gap-3 p-5" aria-labelledby="import-heading">
		<h2 id="import-heading" class="text-lg font-bold tracking-tight">Import</h2>
		<p class="rounded-xl border border-danger/50 bg-danger/10 p-3 text-sm" role="note">
			<strong>Importing replaces all data on this server</strong>: Users, Realms, Labours, Scrolls,
			API tokens and sessions, in one step. You will be signed out and must sign in as a User from
			the bundle. Nothing is kept of the data it replaces, so download an export first if you may
			want it back. A bundle from the SQLite build imports too.
		</p>
		<form onsubmit={upload} class="grid gap-3">
			<label class="grid gap-1">
				<span class="label">Export bundle (.zip, up to {bytes(data.importMaxBytes)})</span>
				<input
					type="file"
					accept=".zip,application/zip"
					class="field"
					required
					onchange={(e) => (bundle = e.currentTarget.files?.[0] ?? null)}
				/>
			</label>
			<label class="grid gap-1">
				<span class="label">Type {data.importConfirmation} to confirm</span>
				<input
					class="field w-64"
					autocomplete="off"
					bind:value={confirmation}
					name="confirmation"
				/>
			</label>
			<div>
				<button
					type="submit"
					class="btn btn-danger"
					disabled={uploading || !bundle || confirmation !== data.importConfirmation}
				>
					{uploading ? `Uploading ${Math.round(progress * 100)}%` : 'Replace all data'}
				</button>
			</div>
			{#if importError}<p role="alert" class="error">{importError}</p>{/if}
			{#if imported}<p role="status" class="text-sm font-semibold" data-testid="import-done">
					Data replaced. <a href={resolve('/login')} class="underline">Sign in again</a>.
				</p>{/if}
		</form>
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
