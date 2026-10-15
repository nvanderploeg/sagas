<script lang="ts">
	import { theme, type Theme } from '../ui/theme.svelte.ts';

	const options: { value: Theme; label: string; glyph: string }[] = [
		{ value: 'system', label: 'System', glyph: '◐' },
		{ value: 'light', label: 'Light', glyph: '☀' },
		{ value: 'dark', label: 'Dark', glyph: '☾' }
	];
</script>

<div class="toggle" role="radiogroup" aria-label="Theme">
	{#each options as option (option.value)}
		<button
			type="button"
			role="radio"
			aria-checked={theme.value === option.value}
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
