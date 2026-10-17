<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import StatePill from './StatePill.svelte';
	import StyleForm from './StyleForm.svelte';

	let {
		action,
		hidden,
		def,
		lockLabel = false,
		submit,
		meta,
		actions
	}: {
		action: string;
		hidden: Record<string, string | number>;
		def: { label: string; color: string; icon: string };
		lockLabel?: boolean;
		submit: string;
		meta?: Snippet;
		actions?: Snippet;
	} = $props();

	let editing = $state(false);
	let editButton = $state<HTMLButtonElement | null>(null);

	async function close() {
		editing = false;
		await tick();
		editButton?.focus();
	}
</script>

{#if editing}
	<StyleForm
		{action}
		{hidden}
		label={def.label}
		color={def.color}
		icon={def.icon}
		{lockLabel}
		name={def.label}
		{submit}
		focus
		onsaved={close}
		oncancel={close}
	/>
{:else}
	<div class="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1">
		<StatePill {def} />
		{@render meta?.()}
		<span class="ml-auto flex flex-wrap items-center justify-end [&_.btn]:whitespace-nowrap">
			<button
				class="btn btn-quiet"
				type="button"
				aria-label="Edit {def.label}"
				bind:this={editButton}
				onclick={() => (editing = true)}>Edit</button
			>
			{@render actions?.()}
		</span>
	</div>
{/if}
