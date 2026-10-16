<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { stream } from '../live/stream.svelte.ts';
	import type { Person } from '../ui/people.ts';
	import AdvancedToggle from './AdvancedToggle.svelte';
	import Avatar from './Avatar.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	let { user }: { user: Person & { isAdmin: boolean } } = $props();

	const connection = $derived(
		{ idle: 'Offline', connecting: 'Connecting', live: 'Live', retrying: 'Reconnecting' }[
			stream.status
		]
	);
	const path = $derived(page.url.pathname);
	const links = $derived([
		{ href: resolve('/'), label: 'Home', active: path === '/' },
		{ href: resolve('/quests'), label: 'Quests', active: path.startsWith('/quests') },
		...(user.isAdmin
			? [{ href: resolve('/admin'), label: 'Admin', active: path.startsWith('/admin') }]
			: [])
	]);
</script>

<header class="bar">
	<a class="brand" href={resolve('/')}>
		<span class="dot conn-{stream.status}" aria-hidden="true"></span>sagas
	</a>
	<nav aria-label="Main">
		{#each links as link (link.href)}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved above -->
			<a href={link.href} aria-current={link.active ? 'page' : undefined}>{link.label}</a>
		{/each}
	</nav>
	<div class="end">
		{#if stream.status !== 'idle'}
			<span class="conn" data-testid="connection" data-status={stream.status}>{connection}</span>
		{/if}
		<AdvancedToggle />
		<ThemeToggle />
		<a class="me" href={resolve('/account')} aria-label="Your account ({user.displayName})">
			<Avatar person={user} />
		</a>
	</div>
</header>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 0.75rem 1.5rem;
		padding: 0.85rem 1rem;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-mono);
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: var(--color-muted);
		transition:
			background-color 0.4s ease,
			box-shadow 0.4s ease;
	}

	.conn-live {
		background: #22c55e;
		box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent);
	}

	.conn-retrying,
	.conn-connecting {
		background: #eab308;
	}

	nav {
		display: flex;
		gap: 0.25rem;
		min-width: 0;
		overflow-x: auto;
	}

	nav a {
		padding: 0.3rem 0.6rem;
		border-radius: 0.5rem;
		color: var(--color-muted);
		font-size: 0.92rem;
		font-weight: 500;
		white-space: nowrap;
	}

	nav a:hover {
		color: var(--color-ink);
	}

	nav a[aria-current='page'] {
		background: var(--color-panel);
		color: var(--color-ink);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.end {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-left: auto;
	}

	.conn {
		color: var(--color-muted);
		font-size: 0.82rem;
	}

	.me {
		display: inline-flex;
		border-radius: 999px;
	}

	@media (max-width: 40rem) {
		.bar {
			flex-wrap: wrap;
		}

		nav {
			order: 3;
			width: 100%;
		}

		.conn {
			display: none;
		}
	}
</style>
