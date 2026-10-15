<script lang="ts">
	import { tick } from 'svelte';

	let {
		label,
		confirm,
		onconfirm,
		type = 'button',
		name,
		value,
		disabled = false
	}: {
		label: string;
		confirm: string;
		onconfirm?: () => void;
		type?: 'button' | 'submit';
		name?: string;
		value?: string;
		disabled?: boolean;
	} = $props();

	let armed = $state(false);
	let armButton = $state<HTMLButtonElement | null>(null);
	let confirmButton = $state<HTMLButtonElement | null>(null);

	// Each pair of buttons replaces the other; focus follows to the one that appears.
	async function setArmed(next: boolean) {
		armed = next;
		await tick();
		(next ? confirmButton : armButton)?.focus();
	}
</script>

{#if armed}
	<span class="inline-flex flex-wrap items-center gap-1.5">
		<button
			class="btn btn-danger"
			{type}
			{name}
			{value}
			bind:this={confirmButton}
			onkeydown={(e) => e.key === 'Escape' && setArmed(false)}
			onclick={() => {
				if (type === 'button') {
					setArmed(false);
					onconfirm?.();
				}
			}}>{confirm}</button
		>
		<button class="btn btn-quiet" type="button" onclick={() => setArmed(false)}>Cancel</button>
	</span>
{:else}
	<button
		class="btn btn-danger"
		type="button"
		{disabled}
		bind:this={armButton}
		onclick={() => setArmed(true)}>{label}</button
	>
{/if}
