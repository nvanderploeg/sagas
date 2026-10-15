<script lang="ts">
	import { glyph } from '../ui/icons.ts';

	let {
		def,
		variant = 'pill',
		label
	}: {
		def: { label: string; color: string; icon: string };
		variant?: 'dot' | 'pill' | 'badge';
		label?: string;
	} = $props();
</script>

<span class="mark {variant}" style:--sc={def.color} data-testid="state-pill">
	<span class="glyph" aria-hidden="true">{glyph(def.icon)}</span>
	{#if variant !== 'dot'}<span class="text">{label ?? def.label}</span>{:else}<span class="sr-only"
			>{label ?? def.label}</span
		>{/if}
</span>

<style>
	.mark {
		--tint: color-mix(in srgb, var(--sc) 20%, var(--color-panel));
		--edge: color-mix(in srgb, var(--sc) 55%, transparent);
		--text: color-mix(in srgb, var(--sc) 58%, var(--color-ink));
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.4em;
		max-width: 100%;
		border: 1.5px solid var(--edge);
		border-radius: 999px;
		background-color: var(--tint);
		color: var(--text);
		line-height: 1;
		white-space: nowrap;
		transition:
			background-color 0.4s ease,
			border-color 0.4s ease,
			color 0.4s ease;
	}

	.dot {
		width: 1.35rem;
		height: 1.35rem;
		font-size: 0.74rem;
	}

	.pill {
		padding: 0.3em 0.75em 0.3em 0.58em;
		font-size: 0.86rem;
		font-weight: 600;
	}

	.badge {
		border-width: 1px;
		padding: 0.18em 0.5em 0.18em 0.42em;
		font-size: 0.72rem;
		font-weight: 600;
	}

	.glyph {
		font-family: var(--font-mono);
		font-weight: 700;
	}

	.text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
