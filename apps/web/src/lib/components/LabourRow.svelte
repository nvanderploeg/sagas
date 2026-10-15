<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Realm, Labour } from '../live/types.ts';
	import { FALLBACK_STATE, stateOf } from '../ui/lookup.ts';
	import type { Person } from '../ui/people.ts';
	import Avatar from './Avatar.svelte';
	import StatePill from './StatePill.svelte';

	let {
		labour,
		realms,
		people,
		lead,
		actions
	}: {
		labour: Labour;
		realms: Realm[];
		people: Map<number, Person>;
		lead?: Snippet;
		actions?: Snippet;
	} = $props();

	const where = $derived(stateOf(realms, labour));
	const assignee = $derived(labour.assigneeId === null ? null : people.get(labour.assigneeId));
</script>

<div class="row" class:closed={labour.closed} data-testid="labour-row" data-labour-key={labour.key}>
	{#if lead}{@render lead()}{/if}
	<a class="main" href={resolve('/l/[key]', { key: labour.key })}>
		<span class="key">{labour.key}</span>
		<span class="title">{labour.title}</span>
	</a>
	<span class="state">
		<StatePill def={where.state ?? FALLBACK_STATE} variant="badge" />
		{#if where.substate}<StatePill def={where.substate} variant="badge" />{/if}
	</span>
	{#if assignee}<Avatar person={assignee} size="xs" title="Assignee: {assignee.displayName}" />{/if}
	{#if actions}{@render actions()}{/if}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.6rem;
		padding: 0.35rem 0.75rem;
	}

	.main {
		display: flex;
		flex: 1;
		align-items: baseline;
		gap: 0.6rem;
		min-width: 0;
	}

	.main:hover .title {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.title {
		min-width: 0;
		overflow: hidden;
		font-weight: 550;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.closed .title {
		color: var(--color-muted);
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, var(--color-muted) 50%, transparent);
	}

	.state {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.3rem;
	}

	@media (max-width: 30rem) {
		.row {
			flex-wrap: wrap;
		}

		.main {
			flex-basis: 100%;
		}
	}
</style>
