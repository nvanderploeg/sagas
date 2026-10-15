<script lang="ts">
	import { resolve } from '$app/paths';
	import type { State, Substate, Labour } from '../../live/types.ts';
	import { personColor, type Person } from '../../ui/people.ts';
	import Avatar from '../Avatar.svelte';
	import Burst from '../Burst.svelte';
	import StatePill from '../StatePill.svelte';

	let {
		labour,
		state,
		substate,
		assignee,
		glow = null,
		burst = 0,
		lifted = false,
		floating = false,
		describedby,
		onpointerdown,
		onhandledown,
		onkeydown
	}: {
		labour: Labour;
		state: State | undefined;
		substate: Substate | undefined;
		assignee: Person | null | undefined;
		glow?: { actor: Person; n: number } | null;
		burst?: number;
		lifted?: boolean;
		floating?: boolean;
		describedby?: string;
		onpointerdown?: (event: PointerEvent) => void;
		onhandledown?: (event: PointerEvent) => void;
		onkeydown?: (event: KeyboardEvent) => void;
	} = $props();

	const draft = $derived(labour.id < 0);
	const color = $derived(state?.color ?? '#9ca3af');
</script>

<div
	class="card"
	class:closed={labour.closed}
	class:lifted
	class:floating
	class:draft
	style:--sc={color}
	style:--gc={glow ? personColor(glow.actor.username) : undefined}
>
	{#if draft}
		<span class="key">New</span>
		<p class="title">{labour.title}</p>
	{:else}
		<a
			class="hit"
			href={resolve('/l/[key]', { key: labour.key })}
			draggable="false"
			aria-describedby={describedby}
			data-card-link={labour.id}
			{onpointerdown}
			{onkeydown}
			ondragstart={(e) => e.preventDefault()}
		>
			<span class="sr-only">{labour.key}: {labour.title}</span>
		</a>
		<div class="top" aria-hidden="true">
			<span class="key">{labour.key}</span>
			{#if substate}<StatePill def={substate} variant="badge" />{/if}
		</div>
		<p class="title" aria-hidden="true">{labour.title}</p>
		{#if labour.labels.length > 0}
			<ul class="labels" aria-label="Labels">
				{#each labour.labels as label (label)}<li>{label}</li>{/each}
			</ul>
		{/if}
		<div class="foot">
			<span class="grow"></span>
			{#if assignee}<Avatar
					person={assignee}
					size="xs"
					title="Assignee: {assignee.displayName}"
				/>{/if}
			<button
				type="button"
				class="handle"
				aria-label="Drag {labour.key}"
				tabindex="-1"
				onpointerdown={onhandledown}>⠿</button
			>
		</div>
	{/if}
	{#if glow}
		{#key glow.n}
			<span class="glow" aria-hidden="true"></span>
			<span class="by" data-testid="remote-editor" title="Changed by {glow.actor.displayName}">
				<Avatar person={glow.actor} size="xs" />
			</span>
		{/key}
	{/if}
	{#if burst}
		{#key burst}<Burst {color} />{/key}
	{/if}
</div>

<style>
	.card {
		position: relative;
		display: grid;
		gap: 0.3rem;
		padding: 0.6rem 0.7rem 0.55rem 0.95rem;
		border: 1px solid var(--color-line);
		border-radius: 0.8rem;
		background: var(--color-panel);
		box-shadow: 0 1px 1px rgb(0 0 0 / 0.03);
		user-select: none;
		-webkit-user-select: none;
		transition:
			border-color 0.2s ease,
			box-shadow 0.2s ease,
			opacity 0.3s ease;
	}

	.card::before {
		content: '';
		position: absolute;
		inset: 0.5rem auto 0.5rem 0;
		width: 0.25rem;
		border-radius: 0 999px 999px 0;
		background: var(--sc);
		transition: background-color 0.4s ease;
	}

	.card:hover {
		border-color: color-mix(in srgb, var(--sc) 45%, var(--color-line));
	}

	.card:has(.hit:focus-visible) {
		outline: 2px solid var(--color-ink);
		outline-offset: 2px;
	}

	.hit {
		position: absolute;
		inset: 0;
		z-index: 1;
		border-radius: inherit;
		cursor: pointer;
	}

	.hit:focus-visible {
		outline: none;
	}

	:global(html.dragging) .hit {
		cursor: grabbing;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: 0.92rem;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.labels li {
		padding: 0 0.45rem;
		border: 1px solid var(--color-line);
		border-radius: 999px;
		background: var(--color-panel-2);
		color: var(--color-muted);
		font-size: 0.7rem;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 1.25rem;
	}

	.grow {
		flex: 1;
	}

	.closed .title {
		color: var(--color-muted);
	}

	.handle {
		display: none;
		position: relative;
		z-index: 2;
		margin: -0.3rem -0.35rem -0.3rem 0;
		padding: 0.3rem 0.4rem;
		border-radius: 0.4rem;
		color: var(--color-muted);
		font-size: 0.9rem;
		line-height: 1;
		touch-action: none;
		cursor: grab;
	}

	@media (pointer: coarse) {
		.handle {
			display: inline-block;
		}
	}

	.lifted {
		border-style: dashed;
		border-color: var(--sc);
		box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--sc) 70%, transparent);
	}

	.floating {
		border-color: color-mix(in srgb, var(--sc) 55%, var(--color-line));
		box-shadow:
			0 22px 40px -18px rgb(0 0 0 / 0.45),
			0 0 0 1px color-mix(in srgb, var(--sc) 30%, transparent);
	}

	.draft {
		opacity: 0.6;
	}

	.glow {
		position: absolute;
		inset: -1px;
		border-radius: inherit;
		pointer-events: none;
		animation: glow 2.2s ease-out forwards;
	}

	.by {
		position: absolute;
		top: -0.55rem;
		right: -0.45rem;
		z-index: 3;
		animation: tag 2.4s ease-out forwards;
	}

	@keyframes glow {
		0% {
			box-shadow:
				0 0 0 2px var(--gc),
				0 0 24px color-mix(in srgb, var(--gc) 65%, transparent);
		}
		100% {
			box-shadow:
				0 0 0 2px transparent,
				0 0 22px transparent;
		}
	}

	@keyframes tag {
		0% {
			opacity: 0;
			transform: scale(0.6);
		}
		10%,
		75% {
			opacity: 1;
			transform: scale(1);
		}
		100% {
			opacity: 0;
			transform: scale(0.9);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.glow {
			animation: none;
			box-shadow: 0 0 0 2px var(--gc);
		}

		.by {
			animation: none;
		}
	}
</style>
