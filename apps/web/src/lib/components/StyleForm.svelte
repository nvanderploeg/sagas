<script lang="ts">
	import { enhance } from '$app/forms';
	import { ICON_NAMES, glyph } from '../ui/icons.ts';
	import StatePill from './StatePill.svelte';

	let {
		action,
		hidden = {},
		label = '',
		color = '#94a3b8',
		icon = 'circle',
		lockLabel = false,
		submit,
		name
	}: {
		action: string;
		hidden?: Record<string, string | number>;
		label?: string;
		color?: string;
		icon?: string;
		lockLabel?: boolean;
		submit: string;
		name: string;
	} = $props();

	const id = $props.id();
	let draftLabel = $derived(label);
	let draftColor = $derived(color);
	let draftIcon = $derived(icon);
	const fresh = $derived(label === '');
</script>

<form
	method="POST"
	{action}
	class="flex flex-wrap items-end gap-2"
	use:enhance={() =>
		async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success' && fresh) draftLabel = '';
		}}
>
	{#each Object.entries(hidden) as [key, value] (key)}
		<input type="hidden" name={key} {value} />
	{/each}
	<span class="self-center">
		<StatePill def={{ label: draftLabel || name, color: draftColor, icon: draftIcon }} />
	</span>
	<label class="grid gap-1">
		<span class="label text-xs">Label</span>
		{#if lockLabel}
			<input
				id="{id}-label"
				class="field w-36 bg-panel-2"
				value={label}
				readonly
				aria-describedby="{id}-locked"
			/>
		{:else}
			<input
				id="{id}-label"
				name="label"
				class="field w-36"
				required
				maxlength="64"
				aria-label="{name} label"
				bind:value={draftLabel}
			/>
		{/if}
	</label>
	<label class="grid gap-1">
		<span class="label text-xs">Colour</span>
		<input
			type="color"
			name="color"
			class="h-[2.15rem] w-12 cursor-pointer rounded-lg border border-line bg-panel p-1"
			aria-label="{name} colour"
			bind:value={draftColor}
		/>
	</label>
	<label class="grid gap-1">
		<span class="label text-xs">Icon</span>
		<select name="icon" class="field w-36" aria-label="{name} icon" bind:value={draftIcon}>
			{#if !ICON_NAMES.includes(draftIcon)}<option value={draftIcon}>{draftIcon}</option>{/if}
			{#each ICON_NAMES as option (option)}
				<option value={option}>{glyph(option)} {option}</option>
			{/each}
		</select>
	</label>
	<button type="submit" class="btn">{submit}</button>
	{#if lockLabel}
		<p id="{id}-locked" class="w-full text-xs text-muted">
			Closed is built in: it keeps its name and stays last.
		</p>
	{/if}
</form>
