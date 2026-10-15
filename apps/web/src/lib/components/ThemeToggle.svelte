<script lang="ts">
	import { theme, type Theme } from '../ui/theme.svelte.ts';

	const options: { value: Theme; label: string; glyph: string }[] = [
		{ value: 'system', label: 'System', glyph: '◐' },
		{ value: 'light', label: 'Light', glyph: '☀' },
		{ value: 'dark', label: 'Dark', glyph: '☾' }
	];

	let group = $state<HTMLElement | null>(null);

	// A radio group is one tab stop; arrow keys move the choice and focus with it.
	function onkeydown(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		const at = options.findIndex((o) => o.value === theme.value);
		let next: number | undefined;
		if (step !== undefined) next = (at + step + options.length) % options.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = options.length - 1;
		if (next === undefined) return;
		event.preventDefault();
		theme.set(options[next].value);
		group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
	}
</script>

<div
	class="toggle"
	role="radiogroup"
	aria-label="Theme"
	tabindex="-1"
	bind:this={group}
	{onkeydown}
>
	{#each options as option (option.value)}
		{@const checked = theme.value === option.value}
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			tabindex={checked ? 0 : -1}
			title="{option.label} theme"
			onclick={() => theme.set(option.value)}
			><span aria-hidden="true">{option.glyph}</span><span class="sr-only">{option.label}</span
			></button
		>
	{/each}
</div>

<style>
	.toggle {
		display: inline-flex;
		padding: 2px;
		border: 1px solid var(--color-line);
		border-radius: 999px;
		background: var(--color-panel);
	}

	button {
		display: grid;
		place-items: center;
		width: 1.7rem;
		height: 1.7rem;
		border-radius: 999px;
		color: var(--color-muted);
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}

	button:hover {
		color: var(--color-ink);
	}

	button[aria-checked='true'] {
		background: var(--color-panel-2);
		color: var(--color-ink);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}
</style>
