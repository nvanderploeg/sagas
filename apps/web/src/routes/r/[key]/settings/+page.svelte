<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import RealmLayer from '#lib/components/agent/RealmLayer.svelte';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import StyleForm from '#lib/components/StyleForm.svelte';
	import StyleRow from '#lib/components/StyleRow.svelte';
	import { applyToSettings } from '#lib/live/apply.ts';
	import type { SettingsView } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { notices } from '#lib/ui/notices.svelte.ts';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// svelte-ignore state_referenced_locally
	const live = new LiveView<SettingsView>(data.seq, data.settings, applyToSettings);
	$effect(() => live.load(data.settings, data.seq));

	const realm = $derived(live.current?.realm);
	const open = $derived(realm?.states.filter((s) => !s.isClosed) ?? []);
	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;

	$effect(() => {
		const key = realm?.key;
		if (key && resolve('/r/[key]/settings', { key }) !== location.pathname) {
			goto(resolve('/r/[key]/settings', { key }), { replace: true, shallow: true });
		}
	});

	$effect(() => {
		if (live.ended) {
			notices.show('This Realm was deleted.');
			goto(resolve('/'));
		}
	});

	let draftName = $derived(realm?.name ?? '');
	let draftKey = $derived(realm?.key ?? '');
	let addingTo = $state<number | null>(null);

	const keep =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

<svelte:head>
	<title>{realm ? `${realm.name} settings` : 'Settings'} · sagas</title>
</svelte:head>

{#snippet error(scope: string)}
	{#if failure(scope)}<p role="alert" class="error w-full">{failure(scope)}</p>{/if}
{/snippet}

{#snippet move(
	action: string,
	field: string,
	id: number,
	to: number,
	disabled: boolean,
	label: string,
	glyph: string
)}
	<form method="POST" {action} use:enhance>
		<input type="hidden" name={field} value={id} />
		<input type="hidden" name="index" value={to} />
		<button class="btn btn-quiet" type="submit" {disabled} aria-label={label}>{glyph}</button>
	</form>
{/snippet}

{#if realm}
	<main class="mx-auto grid max-w-3xl gap-8 px-4 pt-2 pb-16">
		<header class="grid gap-1">
			<a
				class="w-fit text-sm text-muted hover:text-ink"
				href={resolve('/r/[key]', { key: realm.key })}>← {realm.name}</a
			>
			<h1 class="text-3xl font-extrabold tracking-tight">Realm settings</h1>
		</header>

		<section class="panel grid gap-5 p-5 sm:grid-cols-[1fr_auto]">
			<form method="POST" action="?/rename" use:enhance={keep} class="grid content-start gap-1">
				<label class="label" for="realm-name">Name</label>
				<div class="flex flex-wrap gap-2">
					<input
						id="realm-name"
						name="name"
						class="field min-w-0 flex-1 basis-56"
						required
						maxlength="120"
						bind:value={draftName}
					/>
					{#if draftName !== realm.name}
						<button class="btn btn-primary" type="submit">Save name</button>
					{/if}
				</div>
				{@render error('rename')}
			</form>
			<form method="POST" action="?/rekey" use:enhance={keep} class="grid content-start gap-1">
				<label class="label" for="realm-key">Key</label>
				<div class="flex flex-wrap gap-2">
					<input
						id="realm-key"
						name="key"
						class="field w-28 font-mono uppercase"
						required
						maxlength="6"
						bind:value={draftKey}
						aria-describedby="rekey-help"
					/>
					{#if draftKey.toUpperCase() !== realm.key}
						<button class="btn btn-primary" type="submit">Rename key</button>
					{/if}
				</div>
				{@render error('rekey')}
			</form>
			<p id="rekey-help" class="-mt-3 text-xs text-muted sm:col-span-2">
				Labour keys read <span class="font-mono">{(draftKey || realm.key).toUpperCase()}-1</span>.
				Renaming the key keeps old Labour keys and links working.
			</p>
		</section>

		<section class="grid gap-3" aria-labelledby="states-heading">
			<div>
				<h2 id="states-heading" class="text-lg font-bold tracking-tight">States</h2>
				<p class="text-sm text-muted">
					The board's columns, top to bottom here, left to right there.
				</p>
			</div>
			<ol class="panel track px-4 py-3 sm:px-5">
				{#each realm.states as state, i (state.id)}
					{@const isInitial = state.id === realm.initialStateId}
					{#if state.isClosed}
						<li class="stop slot">
							<StyleForm action="?/addState" name="New State" submit="Add State" />
							{@render error('addState')}
						</li>
					{/if}
					<li
						class="stop"
						class:initial={isInitial}
						class:closed={state.isClosed}
						style:--sc={state.color}
						data-testid="state-settings"
						data-state={state.label}
					>
						<StyleRow
							action="?/updateState"
							hidden={{ stateId: state.id }}
							def={state}
							lockLabel={state.isClosed}
							submit="Save State"
						>
							{#snippet meta()}
								{#if isInitial}
									<span class="text-xs font-semibold">New Labours land here</span>
								{:else if state.isClosed}
									<span class="text-xs text-muted">Built in, always last</span>
								{/if}
							{/snippet}
							{#snippet actions()}
								{#if !state.isClosed}
									{#if !isInitial}
										<form method="POST" action="?/initial" use:enhance>
											<input type="hidden" name="stateId" value={state.id} />
											<button
												class="btn btn-quiet"
												type="submit"
												aria-label="Land new Labours in {state.label}">Make initial</button
											>
										</form>
									{/if}
									{@render move(
										'?/moveState',
										'stateId',
										state.id,
										i - 1,
										i === 0,
										`Move ${state.label} earlier`,
										'↑'
									)}
									{@render move(
										'?/moveState',
										'stateId',
										state.id,
										i + 1,
										i >= open.length - 1,
										`Move ${state.label} later`,
										'↓'
									)}
									<form method="POST" action="?/deleteState" use:enhance>
										<input type="hidden" name="stateId" value={state.id} />
										<ConfirmButton
											type="submit"
											label="Delete"
											quiet
											confirm="Delete {state.label}"
											disabled={isInitial}
										/>
									</form>
								{/if}
							{/snippet}
						</StyleRow>
						{@render error(`state:${state.id}`)}

						<div class="subs">
							{#if state.substates.length > 0}
								<ol class="grid">
									{#each state.substates as substate, j (substate.id)}
										{@const isDefault = substate.id === state.defaultSubstateId}
										<li class="sub" data-testid="substate-settings">
											<StyleRow
												action="?/updateSubstate"
												hidden={{ substateId: substate.id }}
												def={substate}
												submit="Save"
											>
												{#snippet meta()}
													{#if isDefault}<span class="text-xs font-semibold">Default</span>{/if}
												{/snippet}
												{#snippet actions()}
													{#if !isDefault}
														<form method="POST" action="?/defaultSubstate" use:enhance>
															<input type="hidden" name="stateId" value={state.id} />
															<input type="hidden" name="substateId" value={substate.id} />
															<button class="btn btn-quiet" type="submit">Make default</button>
														</form>
													{/if}
													{@render move(
														'?/moveSubstate',
														'substateId',
														substate.id,
														j - 1,
														j === 0,
														`Move ${substate.label} up`,
														'↑'
													)}
													{@render move(
														'?/moveSubstate',
														'substateId',
														substate.id,
														j + 1,
														j === state.substates.length - 1,
														`Move ${substate.label} down`,
														'↓'
													)}
													<form method="POST" action="?/deleteSubstate" use:enhance>
														<input type="hidden" name="substateId" value={substate.id} />
														<ConfirmButton
															type="submit"
															label="Delete"
															quiet
															confirm="Delete {substate.label}"
														/>
													</form>
												{/snippet}
											</StyleRow>
											{@render error(`substate:${substate.id}`)}
										</li>
									{/each}
								</ol>
							{/if}
							{#if addingTo === state.id}
								<div class="sub grid gap-1">
									<StyleForm
										action="?/addSubstate"
										hidden={{ stateId: state.id }}
										name="New Substate of {state.label}"
										submit="Add Substate"
										focus
										oncancel={() => (addingTo = null)}
									/>
									{#if state.substates.length === 0}
										<p class="text-xs text-muted">
											The first Substate takes every Labour in {state.label}.
										</p>
									{/if}
								</div>
							{:else}
								<button
									class="btn btn-quiet -ml-2 text-xs"
									type="button"
									onclick={() => (addingTo = state.id)}>+ New Substate</button
								>
							{/if}
							{@render error(`substates:${state.id}`)}
						</div>
					</li>
				{/each}
			</ol>
		</section>

		{#key realm.id}
			<RealmLayer realmId={realm.id} />
		{/key}

		<section
			class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 p-5"
			aria-labelledby="danger-heading"
		>
			<div>
				<h2 id="danger-heading" class="font-bold tracking-tight">Delete Realm</h2>
				<p class="text-sm text-muted">
					Deletes the Realm and every Labour in it. Quests lose those Labours.
				</p>
			</div>
			<form method="POST" action="?/deleteRealm" use:enhance>
				<ConfirmButton
					type="submit"
					label="Delete Realm"
					confirm="Delete {realm.name} and its Labours"
				/>
			</form>
			{@render error('deleteRealm')}
		</section>
	</main>
{/if}

<style>
	.track {
		--rail: 1.1rem;
	}

	.stop {
		position: relative;
		padding: 0.6rem 0 0.6rem calc(var(--rail) + 1rem);
	}

	.stop::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--rail) / 2 - 1.5px);
		width: 3px;
		background: var(--sc);
	}

	.stop:first-child::before {
		top: 1.7rem;
	}

	.stop.closed::before {
		bottom: auto;
		height: 1.7rem;
	}

	.stop::after {
		content: '';
		position: absolute;
		top: calc(1.7rem - 0.5rem);
		left: calc(var(--rail) / 2 - 0.5rem);
		width: 1rem;
		height: 1rem;
		border: 3px solid var(--sc);
		border-radius: 999px;
		background: var(--color-panel);
	}

	.stop.initial::after {
		background: var(--sc);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sc) 30%, transparent);
	}

	.stop.closed::after {
		border-radius: 0.2rem;
		background: var(--sc);
	}

	.slot::before {
		background: none;
		border-left: 3px dotted var(--color-line);
	}

	.slot::after {
		border: 2px dashed var(--color-muted);
	}

	.slot {
		padding-block: 0.9rem;
	}

	.subs {
		display: grid;
		justify-items: start;
		gap: 0.15rem;
		margin-top: 0.25rem;
		margin-left: 0.35rem;
		padding-left: 0.9rem;
		border-left: 1px solid var(--color-line);
	}

	.subs > ol {
		justify-self: stretch;
	}

	.sub {
		justify-self: stretch;
		padding-block: 0.15rem;
	}
</style>
