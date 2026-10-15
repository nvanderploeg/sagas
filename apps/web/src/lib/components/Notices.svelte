<script lang="ts">
	import { fly } from 'svelte/transition';
	import { motion } from '../ui/motion.svelte.ts';
	import { notices } from '../ui/notices.svelte.ts';
</script>

<div class="notices" aria-live="polite">
	{#each notices.list as notice (notice.id)}
		<div
			class="notice {notice.tone}"
			role={notice.tone === 'error' ? 'alert' : 'status'}
			transition:fly={{ y: 12, duration: motion.ms(180) }}
		>
			<span>{notice.text}</span>
			<button type="button" class="btn-quiet btn" onclick={() => notices.dismiss(notice.id)}>
				<span aria-hidden="true">✕</span><span class="sr-only">Dismiss</span>
			</button>
		</div>
	{/each}
</div>

<style>
	.notices {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		left: 1rem;
		z-index: 60;
		display: grid;
		justify-items: end;
		gap: 0.5rem;
		pointer-events: none;
	}

	.notice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 28rem;
		padding: 0.5rem 0.5rem 0.5rem 0.9rem;
		border: 1px solid var(--color-line);
		border-radius: 0.8rem;
		background: var(--color-panel);
		box-shadow: 0 12px 30px -16px rgb(0 0 0 / 0.45);
		font-size: 0.9rem;
		pointer-events: auto;
	}

	.error {
		border-color: color-mix(in srgb, var(--color-danger) 50%, var(--color-line));
		color: var(--color-danger);
	}
</style>
