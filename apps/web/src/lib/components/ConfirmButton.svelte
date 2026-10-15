<script lang="ts">
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
</script>

{#if armed}
	<span class="inline-flex flex-wrap items-center gap-1.5">
		<button
			class="btn btn-danger"
			{type}
			{name}
			{value}
			onclick={() => {
				if (type === 'button') {
					armed = false;
					onconfirm?.();
				}
			}}>{confirm}</button
		>
		<button class="btn btn-quiet" type="button" onclick={() => (armed = false)}>Cancel</button>
	</span>
{:else}
	<button class="btn btn-danger" type="button" {disabled} onclick={() => (armed = true)}
		>{label}</button
	>
{/if}
