<script lang="ts">
	import Burst from './Burst.svelte';

	let {
		closed,
		total,
		size = 'sm',
		label = 'Quest progress',
		celebrate = 0
	}: {
		closed: number;
		total: number;
		size?: 'sm' | 'lg';
		label?: string;
		// Each new value plays the "Quest complete" moment once.
		celebrate?: number;
	} = $props();

	const pct = $derived(total === 0 ? 0 : Math.round((closed / total) * 100));
	const complete = $derived(total > 0 && closed === total);
	const segments = $derived(total > 1 && total <= 24 ? total : 0);

	let moment = $state(0);
	$effect(() => {
		if (celebrate === 0) return;
		moment = celebrate;
		const timer = setTimeout(() => (moment = 0), 3600);
		return () => clearTimeout(timer);
	});
</script>

<div class="xp {size}" class:complete class:celebrating={moment > 0} data-testid="xp-bar">
	<div
		class="track"
		role="progressbar"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={total}
		aria-valuenow={closed}
		aria-valuetext="{closed} of {total} Tickets closed"
		style:--segments={segments}
	>
		<div class="fill" style:width="{pct}%"></div>
		{#if segments}<div class="ticks" aria-hidden="true"></div>{/if}
		<div class="sheen" aria-hidden="true"></div>
	</div>
	<div class="meta">
		<span class="count"><strong>{closed}</strong> / {total} closed</span>
		{#if complete}
			<span class="done" data-testid="quest-complete-badge">✦ Complete</span>
		{:else}
			<span class="pct">{pct}%</span>
		{/if}
	</div>
	{#key moment}
		{#if moment > 0}
			<div class="moment" role="status" data-testid="quest-complete">
				<Burst color="var(--color-gold)" count={18} />
				<span class="trophy" aria-hidden="true">🏆</span>
				<span class="headline">Quest complete</span>
			</div>
		{/if}
	{/key}
</div>

<style>
	.xp {
		position: relative;
		display: grid;
		gap: 0.35rem;
	}

	.track {
		position: relative;
		height: 0.55rem;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-xp) 14%, var(--color-panel-2));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-xp) 22%, transparent);
	}

	.lg .track {
		height: 1rem;
	}

	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--color-xp) 75%, #38bdf8),
			var(--color-xp)
		);
		transition:
			width 0.9s cubic-bezier(0.22, 1, 0.36, 1),
			background 0.6s ease;
	}

	.complete .fill {
		background: linear-gradient(90deg, #f59e0b, var(--color-gold), #fde047);
	}

	.ticks {
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			90deg,
			transparent 0,
			transparent calc(100% / var(--segments) - 2px),
			var(--color-panel) calc(100% / var(--segments) - 2px),
			var(--color-panel) calc(100% / var(--segments))
		);
		opacity: 0.7;
	}

	.sheen {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			100deg,
			transparent 30%,
			rgb(255 255 255 / 0.65) 50%,
			transparent 70%
		);
		background-size: 250% 100%;
		background-position: 150% 0;
		opacity: 0;
	}

	.celebrating .sheen {
		animation: sheen 1.2s ease-in-out 2;
	}

	.meta {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		color: var(--color-muted);
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}

	.lg .meta {
		font-size: 0.9rem;
	}

	.count strong {
		color: var(--color-ink);
	}

	.done {
		color: color-mix(in srgb, var(--color-gold) 75%, var(--color-ink));
		font-weight: 700;
	}

	.moment {
		position: absolute;
		top: -3.4rem;
		left: 50%;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 1rem;
		border: 1.5px solid color-mix(in srgb, var(--color-gold) 70%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-gold) 20%, var(--color-panel));
		box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--color-gold) 80%, transparent);
		color: color-mix(in srgb, var(--color-gold) 45%, var(--color-ink));
		font-weight: 800;
		letter-spacing: -0.01em;
		white-space: nowrap;
		transform: translateX(-50%);
		animation: pop 3.6s cubic-bezier(0.2, 1.4, 0.4, 1) forwards;
	}

	.trophy {
		font-size: 1.15rem;
	}

	@keyframes pop {
		0% {
			opacity: 0;
			transform: translateX(-50%) translateY(0.6rem) scale(0.7);
		}
		12% {
			opacity: 1;
			transform: translateX(-50%) translateY(0) scale(1.06);
		}
		20%,
		85% {
			opacity: 1;
			transform: translateX(-50%) scale(1);
		}
		100% {
			opacity: 0;
			transform: translateX(-50%) translateY(-0.3rem) scale(0.98);
		}
	}

	@keyframes sheen {
		0% {
			opacity: 1;
			background-position: 150% 0;
		}
		100% {
			opacity: 1;
			background-position: -50% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}

		.celebrating .sheen {
			animation: none;
		}

		.moment {
			animation: fade 3.6s step-end forwards;
		}

		@keyframes fade {
			100% {
				opacity: 0;
			}
		}
	}
</style>
