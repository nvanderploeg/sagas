<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LabourLayerData } from '#lib/ui/agent.ts';
	import { lookFor } from '#lib/ui/directory.ts';
	import type { Person } from '#lib/ui/people.ts';
	import { stamp } from '#lib/ui/time.ts';
	import AgentPanel from './AgentPanel.svelte';
	import Attribution from './Attribution.svelte';
	import Stale from './Stale.svelte';

	let { labourId, people }: { labourId: number; people: Map<number, Person> } = $props();

	const empty = (layer: LabourLayerData) =>
		layer.unappraised &&
		layer.brief === '' &&
		layer.refs.length === 0 &&
		layer.values.length === 0 &&
		layer.needs.length === 0 &&
		layer.links.length === 0 &&
		layer.mentions.length === 0;

	const phrase: Record<string, Record<string, string>> = {
		evidence: { out: 'Evidence for', in: 'Evidence from' },
		blocks: { out: 'Blocks', in: 'Blocked by' },
		relates: { both: 'Relates to' },
		duplicates: { out: 'Duplicates', in: 'Duplicated by' }
	};

	function grouped(links: LabourLayerData['links']) {
		const groups: { key: string; title: string; links: LabourLayerData['links'] }[] = [];
		for (const link of links) {
			const key = `${link.type}:${link.direction}`;
			const group = groups.find((g) => g.key === key);
			if (group) group.links.push(link);
			else
				groups.push({
					key,
					title: phrase[link.type]?.[link.direction] ?? `${link.type} (${link.direction})`,
					links: [link]
				});
		}
		return groups;
	}

	const users = (layer: LabourLayerData) => [
		layer.setBy,
		layer.stamp?.appraisedBy ?? null,
		...layer.values.map((value) => value.setBy),
		...layer.needs.map((need) => need.setBy),
		...layer.links.map((link) => link.setBy),
		...layer.mentions.map((mention) => mention.authorId)
	];

	const web = (href: string) => /^https?:\/\//i.test(href);
	const who = (id: number | null) =>
		id === null ? 'Someone' : (people.get(id)?.displayName ?? 'Someone');
</script>

{#snippet labour(other: { key: string; title: string })}
	<a class="font-semibold hover:underline" href={resolve('/l/[key]', { key: other.key })}
		><span class="key">{other.key}</span> {other.title}</a
	>
{/snippet}

<AgentPanel
	url="/api/agent/labours/{labourId}"
	isEmpty={empty}
	onload={(layer) => lookFor(users(layer), people)}
>
	{#snippet body(layer: LabourLayerData)}
		<section class="grid gap-1" aria-labelledby="agent-appraisal-heading">
			<h3 id="agent-appraisal-heading" class="label">Appraisal</h3>
			<p class="flex flex-wrap items-center gap-2 text-sm" data-testid="agent-stamp">
				{#if layer.stamp}
					<span>
						Appraised by {who(layer.stamp.appraisedBy)}
						<time datetime={layer.stamp.appraisedAt}>{stamp(layer.stamp.appraisedAt)}</time>
					</span>
					{#if layer.stale}
						<Stale />
					{/if}
				{:else}
					<span>Unappraised</span>
				{/if}
			</p>
		</section>

		<section class="grid gap-1" aria-labelledby="agent-brief-heading">
			<h3 id="agent-brief-heading" class="label">Brief</h3>
			{#if layer.brief === ''}
				<p class="text-sm text-muted italic">No Brief.</p>
			{:else}
				<p class="text-sm whitespace-pre-wrap" data-testid="agent-brief">{layer.brief}</p>
				{#if layer.setBy !== null && layer.setAt !== null}
					<p><Attribution {people} by={layer.setBy} at={layer.setAt} /></p>
				{/if}
			{/if}
		</section>

		{#if layer.refs.length > 0}
			<section class="grid gap-1" aria-labelledby="agent-refs-heading">
				<h3 id="agent-refs-heading" class="label">References</h3>
				<ul class="grid gap-1 text-sm">
					{#each layer.refs as ref (ref.href)}
						<li>
							{#if web(ref.href)}
								<!-- eslint-disable svelte/no-navigation-without-resolve -- external Reference -->
								<a
									class="underline"
									href={ref.href}
									target="_blank"
									rel="noopener noreferrer nofollow">{ref.label ?? ref.href}</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{:else}
								<code class="font-mono text-[0.85em]">{ref.href}</code>
								{#if ref.label}<span class="text-muted">{ref.label}</span>{/if}
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if layer.values.length > 0}
			<section class="grid gap-1" aria-labelledby="agent-values-heading">
				<h3 id="agent-values-heading" class="label">Values</h3>
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-values">
					{#each layer.values as value (value.key)}
						<li class="grid gap-0.5 py-2 text-sm">
							<div class="flex flex-wrap items-baseline gap-x-2">
								<span class="font-semibold">{value.label}</span>
								<span class="key">{value.key}</span>
								<span>{value.display}</span>
							</div>
							<div class="flex flex-wrap items-center gap-2">
								<Attribution {people} by={value.setBy} at={value.setAt} stale={value.stale} />
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if layer.needs.length > 0}
			<section class="grid gap-1" aria-labelledby="agent-needs-heading">
				<h3 id="agent-needs-heading" class="label">Needed Skills</h3>
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-needs">
					{#each layer.needs as need (need.key)}
						<li class="flex flex-wrap items-center gap-x-2 py-2 text-sm">
							<span class="font-semibold">{need.label}</span>
							<span class="key">{need.key}</span>
							<span>level {need.level}</span>
							<Attribution {people} by={need.setBy} at={need.setAt} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if layer.links.length > 0}
			<section class="grid gap-2" aria-labelledby="agent-links-heading">
				<h3 id="agent-links-heading" class="label">Links</h3>
				{#each grouped(layer.links) as group (group.key)}
					<div class="grid gap-1" data-testid="agent-link-group">
						<h4 class="text-sm font-semibold">{group.title}</h4>
						<ul class="divide-y divide-line border-t border-line">
							{#each group.links as link (link.other.id)}
								<li class="grid gap-0.5 py-2 text-sm">
									<div class="min-w-0">{@render labour(link.other)}</div>
									{#if link.note !== ''}<p class="whitespace-pre-wrap">{link.note}</p>{/if}
									<div><Attribution {people} by={link.setBy} at={link.setAt} /></div>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
				{#if layer.moreLinks > 0}
					<p class="text-sm text-muted">and {layer.moreLinks} more.</p>
				{/if}
			</section>
		{/if}

		{#if layer.mentions.length > 0}
			<section class="grid gap-1" aria-labelledby="agent-mentions-heading">
				<h3 id="agent-mentions-heading" class="label">Recent Mentions</h3>
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-mentions">
					{#each layer.mentions as mention (mention.source.id + ':' + mention.commentId)}
						<li class="grid gap-0.5 py-2 text-sm">
							<div class="min-w-0">
								{@render labour(mention.source)}
								<span class="text-muted"
									>{mention.commentId === null ? 'description' : 'comment'}</span
								>
							</div>
							<div><Attribution {people} by={mention.authorId} at={mention.firstSeenAt} /></div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/snippet}
</AgentPanel>
