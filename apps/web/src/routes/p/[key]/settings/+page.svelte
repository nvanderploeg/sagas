<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ConfirmButton from '#lib/components/ConfirmButton.svelte';
	import StyleForm from '#lib/components/StyleForm.svelte';
	import { applyToSettings } from '#lib/live/apply.ts';
	import type { SettingsView } from '#lib/live/types.ts';
	import { LiveView } from '#lib/live/view.svelte.ts';
	import { notices } from '#lib/ui/notices.svelte.ts';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// svelte-ignore state_referenced_locally
	const live = new LiveView<SettingsView>(data.seq, data.settings, applyToSettings);
	$effect(() => live.load(data.settings, data.seq));

	const project = $derived(live.current?.project);
	const open = $derived(project?.states.filter((s) => !s.isClosed) ?? []);
	const failure = (scope: string) =>
		form && 'error' in form && form.scope === scope ? String(form.error) : null;

	$effect(() => {
		const key = project?.key;
		if (key && resolve('/p/[key]/settings', { key }) !== location.pathname) {
			goto(resolve('/p/[key]/settings', { key }), { replace: true, shallow: true });
		}
	});

	$effect(() => {
		if (live.ended) {
			notices.show('This Project was deleted.');
			goto(resolve('/'));
		}
	});

	const keep =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

<svelte:head>
	<title>{project ? `${project.name} settings` : 'Settings'} · workload</title>
</svelte:head>

{#snippet error(scope: string)}
	{#if failure(scope)}<p role="alert" class="error w-full">{failure(scope)}</p>{/if}
{/snippet}

{#if project}
	<main class="mx-auto grid max-w-4xl gap-6 px-4 pt-2 pb-16">
		<a
			class="w-fit text-sm text-muted hover:text-ink"
			href={resolve('/p/[key]', { key: project.key })}>← {project.name}</a
		>
		<h1 class="text-4xl font-extrabold tracking-tight">Project settings</h1>

		<section class="panel grid gap-4 p-5" aria-labelledby="project-heading">
			<h2 id="project-heading" class="text-lg font-bold tracking-tight">Project</h2>
			<form
				method="POST"
				action="?/rename"
				use:enhance={keep}
				class="flex flex-wrap items-end gap-2"
			>
				<label class="grid gap-1">
					<span class="label">Name</span>
					<input
						name="name"
						class="field w-72 max-w-full"
						required
						maxlength="120"
						value={project.name}
					/>
				</label>
				<button class="btn" type="submit">Save name</button>
				{@render error('rename')}
			</form>
			<form
				method="POST"
				action="?/rekey"
				use:enhance={keep}
				class="flex flex-wrap items-end gap-2"
			>
				<label class="grid gap-1">
					<span class="label">Key</span>
					<input
						name="key"
						class="field w-28 font-mono uppercase"
						required
						maxlength="6"
						value={project.key}
						aria-describedby="rekey-help"
					/>
				</label>
				<button class="btn" type="submit">Rename key</button>
				<p id="rekey-help" class="w-full text-xs text-muted">
					Every Ticket takes the new key. Old Ticket keys and links keep working.
				</p>
				{@render error('rekey')}
			</form>
		</section>

		<section class="panel grid gap-3 p-5" aria-labelledby="initial-heading">
			<h2 id="initial-heading" class="text-lg font-bold tracking-tight">Initial State</h2>
			<form
				method="POST"
				action="?/initial"
				use:enhance={keep}
				class="flex flex-wrap items-end gap-2"
			>
				<label class="grid gap-1">
					<span class="label">New Tickets land in</span>
					<select name="stateId" class="field w-56" value={project.initialStateId}>
						{#each open as state (state.id)}
							<option value={state.id}>{state.label}</option>
						{/each}
					</select>
				</label>
				<button class="btn" type="submit">Set Initial State</button>
				<p class="w-full text-xs text-muted">Closed can never be the Initial State.</p>
				{@render error('initial')}
			</form>
		</section>

		<section class="grid gap-3" aria-labelledby="states-heading">
			<div>
				<h2 id="states-heading" class="text-lg font-bold tracking-tight">States</h2>
				<p class="text-sm text-muted">The board's columns, left to right. Closed is always last.</p>
			</div>
			<ol class="grid gap-3">
				{#each project.states as state, i (state.id)}
					{@const isInitial = state.id === project.initialStateId}
					<li
						class="panel grid gap-4 p-4"
						style:--sc={state.color}
						data-testid="state-settings"
						data-state={state.label}
					>
						<div class="flex flex-wrap items-start justify-between gap-3">
							<StyleForm
								action="?/updateState"
								hidden={{ stateId: state.id }}
								label={state.label}
								color={state.color}
								icon={state.icon}
								lockLabel={state.isClosed}
								name={state.label}
								submit="Save State"
							/>
							<div class="flex flex-wrap items-center gap-1.5">
								{#if state.isClosed}
									<span class="text-xs font-medium text-muted">Built in · always last</span>
								{:else}
									<form method="POST" action="?/moveState" use:enhance>
										<input type="hidden" name="stateId" value={state.id} />
										<input type="hidden" name="index" value={i - 1} />
										<button
											class="btn btn-quiet"
											type="submit"
											disabled={i === 0}
											aria-label="Move {state.label} earlier">↑</button
										>
									</form>
									<form method="POST" action="?/moveState" use:enhance>
										<input type="hidden" name="stateId" value={state.id} />
										<input type="hidden" name="index" value={i + 1} />
										<button
											class="btn btn-quiet"
											type="submit"
											disabled={i >= open.length - 1}
											aria-label="Move {state.label} later">↓</button
										>
									</form>
									<form method="POST" action="?/deleteState" use:enhance>
										<input type="hidden" name="stateId" value={state.id} />
										<ConfirmButton
											type="submit"
											label="Delete"
											confirm="Delete {state.label}"
											disabled={isInitial}
										/>
									</form>
								{/if}
							</div>
						</div>
						{#if isInitial}
							<p class="-mt-2 text-xs text-muted">The Initial State: pick another to delete it.</p>
						{/if}
						{@render error(`state:${state.id}`)}

						<div class="grid gap-2 border-t border-line pt-3">
							<h3 class="text-sm font-semibold">
								Substates <span class="font-normal text-muted">of {state.label}</span>
							</h3>
							{#if state.substates.length === 0}
								<p class="text-xs text-muted">
									None. Adding the first moves every Ticket in {state.label} into it.
								</p>
							{:else}
								<ol class="grid gap-2">
									{#each state.substates as substate, j (substate.id)}
										{@const isDefault = substate.id === state.defaultSubstateId}
										<li
											class="flex flex-wrap items-end justify-between gap-2 rounded-xl bg-panel-2 p-2.5"
											data-testid="substate-settings"
										>
											<StyleForm
												action="?/updateSubstate"
												hidden={{ substateId: substate.id }}
												label={substate.label}
												color={substate.color}
												icon={substate.icon}
												name={substate.label}
												submit="Save"
											/>
											<div class="flex flex-wrap items-center gap-1.5">
												{#if isDefault}
													<span class="text-xs font-semibold">Default</span>
												{:else}
													<form method="POST" action="?/defaultSubstate" use:enhance>
														<input type="hidden" name="stateId" value={state.id} />
														<input type="hidden" name="substateId" value={substate.id} />
														<button class="btn btn-quiet" type="submit">Make default</button>
													</form>
												{/if}
												<form method="POST" action="?/moveSubstate" use:enhance>
													<input type="hidden" name="substateId" value={substate.id} />
													<input type="hidden" name="index" value={j - 1} />
													<button
														class="btn btn-quiet"
														type="submit"
														disabled={j === 0}
														aria-label="Move {substate.label} up">↑</button
													>
												</form>
												<form method="POST" action="?/moveSubstate" use:enhance>
													<input type="hidden" name="substateId" value={substate.id} />
													<input type="hidden" name="index" value={j + 1} />
													<button
														class="btn btn-quiet"
														type="submit"
														disabled={j === state.substates.length - 1}
														aria-label="Move {substate.label} down">↓</button
													>
												</form>
												<form method="POST" action="?/deleteSubstate" use:enhance>
													<input type="hidden" name="substateId" value={substate.id} />
													<ConfirmButton
														type="submit"
														label="Delete"
														confirm="Delete {substate.label}"
													/>
												</form>
											</div>
											{@render error(`substate:${substate.id}`)}
										</li>
									{/each}
								</ol>
							{/if}
							<div class="rounded-xl border border-dashed border-line p-2.5">
								<StyleForm
									action="?/addSubstate"
									hidden={{ stateId: state.id }}
									name="New Substate of {state.label}"
									submit="Add Substate"
								/>
								{@render error(`substates:${state.id}`)}
							</div>
						</div>
					</li>
				{/each}
			</ol>
			<div class="panel grid gap-2 border-dashed p-4">
				<h3 class="text-sm font-semibold">Add a State</h3>
				<p class="text-xs text-muted">It joins the board just before Closed.</p>
				<StyleForm action="?/addState" name="New State" submit="Add State" />
				{@render error('addState')}
			</div>
		</section>

		<section class="panel grid gap-3 p-5" aria-labelledby="danger-heading">
			<h2 id="danger-heading" class="text-lg font-bold tracking-tight">Delete Project</h2>
			<p class="text-sm text-muted">
				Deletes the Project and every Ticket in it. Quests lose those Tickets.
			</p>
			<form method="POST" action="?/deleteProject" use:enhance>
				<ConfirmButton
					type="submit"
					label="Delete Project"
					confirm="Delete {project.name} and its Tickets"
				/>
			</form>
			{@render error('deleteProject')}
		</section>
	</main>
{/if}
