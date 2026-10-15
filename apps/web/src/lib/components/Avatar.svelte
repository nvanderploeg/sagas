<script lang="ts">
	import { personColors } from '../ui/contrast.ts';
	import { hue, initials, type Person } from '../ui/people.ts';

	let {
		person,
		size = 'sm',
		title
	}: {
		person: Pick<Person, 'username' | 'displayName' | 'kind'>;
		size?: 'xs' | 'sm' | 'md';
		title?: string;
	} = $props();

	const colors = $derived(personColors(hue(person.username)));
</script>

<span
	class="avatar {size}"
	class:agent={person.kind === 'agent'}
	style:--pc={colors.background}
	style:--pt={colors.text}
	title={title ?? person.displayName}
	data-testid="avatar"
	><span aria-hidden="true">{initials(person.displayName)}</span><span class="sr-only"
		>{title ?? person.displayName}</span
	></span
>

<style>
	.avatar {
		display: inline-grid;
		flex: none;
		place-items: center;
		border-radius: 999px;
		background: var(--pc);
		box-shadow: 0 0 0 2px var(--color-panel);
		color: var(--pt);
		font-weight: 700;
		letter-spacing: 0.01em;
		line-height: 1;
	}

	.agent {
		border-radius: 0.4rem;
	}

	.xs {
		width: 1.25rem;
		height: 1.25rem;
		font-size: 0.55rem;
	}

	.sm {
		width: 1.6rem;
		height: 1.6rem;
		font-size: 0.66rem;
	}

	.md {
		width: 2.1rem;
		height: 2.1rem;
		font-size: 0.82rem;
	}
</style>
