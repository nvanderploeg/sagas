<script lang="ts">
	let { color = '#22c55e', count = 14 }: { color?: string; count?: number } = $props();

	const palette = ['var(--color-gold)', 'var(--color-xp)', '#f472b6', '#38bdf8'];
	// svelte-ignore state_referenced_locally
	const bits = Array.from({ length: count }, (_, i) => ({
		angle: (360 / count) * i + Math.random() * 18 - 9,
		distance: 34 + Math.random() * 30,
		size: 5 + Math.random() * 5,
		delay: Math.random() * 70,
		spin: Math.random() * 360 - 180,
		color: i % 3 === 0 ? color : palette[i % palette.length],
		spark: i % 4 === 1
	}));
</script>

<span class="burst" aria-hidden="true" data-testid="loot-burst">
	<span class="ring" style:--c={color}></span>
	{#each bits as bit, i (i)}
		<span
			class="bit"
			class:spark={bit.spark}
			style:--a="{bit.angle}deg"
			style:--d="{bit.distance}px"
			style:--s="{bit.size}px"
			style:--r="{bit.spin}deg"
			style:--c={bit.color}
			style:animation-delay="{bit.delay}ms"
		>
			{#if bit.spark}✦{/if}
		</span>
	{/each}
</span>

<style>
	.burst {
		position: absolute;
		top: 50%;
		left: 50%;
		z-index: 5;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.ring {
		position: absolute;
		top: -1.2rem;
		left: -1.2rem;
		width: 2.4rem;
		height: 2.4rem;
		border: 2px solid var(--c);
		border-radius: 999px;
		opacity: 0;
		animation: ring 0.6s ease-out forwards;
	}

	.bit {
		position: absolute;
		top: calc(var(--s) / -2);
		left: calc(var(--s) / -2);
		width: var(--s);
		height: var(--s);
		border-radius: 1px;
		background: var(--c);
		opacity: 0;
		animation: fly 0.85s cubic-bezier(0.16, 0.84, 0.3, 1) forwards;
	}

	.spark {
		display: grid;
		place-items: center;
		width: auto;
		height: auto;
		background: none;
		color: var(--c);
		font-size: calc(var(--s) * 2);
		line-height: 1;
	}

	@keyframes fly {
		0% {
			opacity: 1;
			transform: rotate(var(--a)) translateX(0) rotate(45deg) scale(0.4);
		}
		60% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: rotate(var(--a)) translateX(var(--d)) rotate(calc(45deg + var(--r))) scale(1);
		}
	}

	@keyframes ring {
		0% {
			opacity: 0.9;
			transform: scale(0.3);
		}
		100% {
			opacity: 0;
			transform: scale(2.2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.burst {
			display: none;
		}
	}
</style>
