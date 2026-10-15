<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Project, Ticket } from '../live/types.ts';
	import { FALLBACK_STATE, stateOf } from '../ui/lookup.ts';
	import type { Person } from '../ui/people.ts';
	import Avatar from './Avatar.svelte';
	import StatePill from './StatePill.svelte';

	let {
		ticket,
		projects,
		people,
		lead,
		actions
	}: {
		ticket: Ticket;
		projects: Project[];
		people: Map<number, Person>;
		lead?: Snippet;
		actions?: Snippet;
	} = $props();

	const where = $derived(stateOf(projects, ticket));
	const assignee = $derived(ticket.assigneeId === null ? null : people.get(ticket.assigneeId));
</script>

<div class="row" class:closed={ticket.closed} data-testid="ticket-row" data-ticket-key={ticket.key}>
	{#if lead}{@render lead()}{/if}
	<a class="main" href={resolve('/t/[key]', { key: ticket.key })}>
		<span class="key">{ticket.key}</span>
		<span class="title">{ticket.title}</span>
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
