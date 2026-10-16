<script lang="ts">
	import { advanced } from '../ui/advanced.svelte.ts';
</script>

<button
	type="button"
	role="switch"
	class="switch"
	aria-checked={advanced.on}
	onclick={() => advanced.set(!advanced.on)}
>
	<span class="track" aria-hidden="true"><span class="thumb"></span></span>
	<span class="text">Advanced view</span>
</button>

<style>
	.switch {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border-radius: 999px;
		color: var(--color-muted);
		font-size: 0.82rem;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
	}

	.switch:hover {
		color: var(--color-ink);
	}

	.track {
		display: inline-flex;
		align-items: center;
		width: 1.9rem;
		height: 1.1rem;
		padding: 2px;
		border: 1px solid var(--color-line);
		border-radius: 999px;
		background: var(--color-panel);
		transition: background-color 0.2s ease;
	}

	.thumb {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 50%;
		background: var(--color-muted);
		transition:
			transform 0.2s ease,
			background-color 0.2s ease;
	}

	[aria-checked='true'] .track {
		background: var(--color-panel-2);
		border-color: var(--color-ink);
	}

	[aria-checked='true'] .thumb {
		background: var(--color-ink);
		transform: translateX(0.8rem);
	}

	[aria-checked='true'] .text {
		color: var(--color-ink);
	}
</style>
