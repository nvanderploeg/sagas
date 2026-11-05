<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Recurrence = PageData['recurrences'][number];

	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;

	function cadence(r: { unit: string; every: number }): string {
		return r.every === 1 ? `Every ${r.unit}` : `Every ${r.every} ${r.unit}s`;
	}

	function status(r: Recurrence): string {
		if (r.paused) return 'Paused';
		if (r.nextDueAt) return `Next on ${new Date(r.nextDueAt).toLocaleDateString()}`;
		return r.labour && !r.labour.closed ? 'Waiting for the open Labour to be finished' : 'Due now';
	}
</script>

<svelte:head>
	<title>{data.realm.name} recurrences · sagas</title>
</svelte:head>

{#snippet fields(r: Recurrence | null)}
	<label class="grid gap-1 sm:col-span-2">
		<span class="label">Title</span>
		<input name="title" required maxlength="200" value={r?.title ?? ''} class="field" />
	</label>
	<label class="grid gap-1 sm:col-span-2">
		<span class="label">Description</span>
		<textarea name="description" rows="3" class="field">{r?.description ?? ''}</textarea>
	</label>
	<label class="grid gap-1">
		<span class="label">Every</span>
		<span class="flex gap-2">
			<input
				name="every"
				type="number"
				min="1"
				max="1000"
				required
				value={r?.every ?? 1}
				class="field w-20"
			/>
			<select name="unit" class="field">
				{#each ['day', 'week', 'month', 'year'] as unit (unit)}
					<option value={unit} selected={(r?.unit ?? 'month') === unit}>{unit}(s)</option>
				{/each}
			</select>
		</span>
	</label>
	<label class="grid gap-1">
		<span class="label">Starts on</span>
		<input
			name="startsOn"
			type="date"
			required={r !== null}
			value={r?.startsOn ?? ''}
			class="field"
		/>
	</label>
	<label class="grid gap-1 sm:col-span-2">
		<span class="label">Timezone</span>
		<input name="timezone" required value={r?.timezone ?? zone} class="field" />
	</label>
	{#if data.quests.length > 0}
		<fieldset class="grid gap-1 sm:col-span-2">
			<legend class="label">Add each new Labour to</legend>
			<div class="flex flex-wrap gap-3">
				{#each data.quests as quest (quest.id)}
					<label class="flex items-center gap-1.5 text-sm">
						<input
							type="checkbox"
							name="questIds"
							value={quest.id}
							checked={r?.questIds.includes(quest.id) ?? false}
						/>
						{quest.name}
					</label>
				{/each}
			</div>
		</fieldset>
	{/if}
	{#if r}
		<label class="flex items-center gap-2 text-sm sm:col-span-2">
			<input type="checkbox" name="paused" checked={r.paused} />
			Paused
		</label>
	{/if}
{/snippet}

<main class="mx-auto grid max-w-3xl gap-6 px-4 pt-4 pb-16">
	<div>
		<a class="key hover:underline" href={resolve('/r/[key]', { key: data.realm.key })}>
			← {data.realm.name}
		</a>
		<h1 class="mt-1 text-4xl font-extrabold tracking-tight">Recurrences</h1>
		<p class="mt-1 max-w-prose text-muted">
			A Recurrence creates a Labour on a schedule. When you finish it, the next one is created at
			the next scheduled date. Dates that pass while a Labour is still open are skipped.
		</p>
	</div>

	{#if data.canEdit}
		<form method="POST" action="?/create" use:enhance class="panel grid gap-3 p-4 sm:grid-cols-2">
			<h2 class="font-bold sm:col-span-2">New Recurrence</h2>
			{@render fields(null)}
			<div class="sm:col-span-2">
				<button type="submit" class="btn btn-primary">Create Recurrence</button>
			</div>
			{#if failure('create')}<p role="alert" class="error sm:col-span-2">
					{failure('create')}
				</p>{/if}
		</form>
	{/if}

	{#if data.recurrences.length === 0}
		<p class="panel p-6 text-muted">No Recurrences yet.</p>
	{:else}
		<ul class="grid gap-3">
			{#each data.recurrences as r (r.id)}
				<li class="panel grid gap-2 p-4" data-testid="recurrence">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<h2 class="text-lg font-bold tracking-tight">{r.title}</h2>
						<span class="key">{cadence(r)}</span>
					</div>
					<p class="text-sm text-muted">
						{status(r)}
						{#if r.labour}
							·
							<a class="underline" href={resolve('/l/[key]', { key: r.labour.key })}>
								{r.labour.key}
							</a>
						{/if}
					</p>
					{#if data.canEdit}
						<details>
							<summary class="btn btn-quiet inline-flex">Edit</summary>
							<form
								method="POST"
								action="?/update"
								use:enhance
								class="mt-3 grid gap-3 sm:grid-cols-2"
							>
								<input type="hidden" name="id" value={r.id} />
								{@render fields(r)}
								<div class="flex gap-2 sm:col-span-2">
									<button type="submit" class="btn btn-primary">Save</button>
								</div>
							</form>
							<form method="POST" action="?/delete" use:enhance class="mt-2">
								<input type="hidden" name="id" value={r.id} />
								<ConfirmButton label="Delete" confirm="Delete; its Labours stay" type="submit" />
							</form>
							{#if failure('update')}<p role="alert" class="error">{failure('update')}</p>{/if}
							{#if failure('delete')}<p role="alert" class="error">{failure('delete')}</p>{/if}
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
