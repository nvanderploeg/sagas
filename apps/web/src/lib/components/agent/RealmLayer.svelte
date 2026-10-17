<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import { signed, type RealmLayerData } from '#lib/ui/agent.ts';
	import AgentPanel from './AgentPanel.svelte';

	let { realmId }: { realmId: number } = $props();

	const empty = (layer: RealmLayerData) =>
		layer.notes === '' &&
		layer.attributes.length === 0 &&
		layer.sentiment.length === 0 &&
		layer.unfiled.length === 0;

	type Attribute = RealmLayerData['attributes'][number];

	function tally(attribute: Attribute) {
		const members: { key: string; label: string }[] =
			attribute.kind === 'tags' && attribute.spec && 'members' in attribute.spec
				? (attribute.spec.members as { key: string; label: string }[])
				: [];
		const labels = new Map(members.map((member) => [member.key, member.label]));
		return Object.entries(attribute.counts).map(([key, count]) => ({
			key,
			label: labels.get(key) ?? key,
			count
		}));
	}
</script>

<AgentPanel url="/api/agent/realms/{realmId}" isEmpty={empty}>
	{#snippet body(layer: RealmLayerData)}
		<section class="grid gap-1" aria-labelledby="agent-notes-heading">
			<h3 id="agent-notes-heading" class="label">Agent notes</h3>
			<Markdown source={layer.notes} empty="No notes." />
			<p class="text-xs text-muted">
				Half-life {layer.halfLifeDays} days · Loudness {layer.loudness}
			</p>
		</section>

		<section class="grid gap-1" aria-labelledby="agent-attributes-heading">
			<h3 id="agent-attributes-heading" class="label">
				Attributes <span class="font-normal">{layer.attributes.length}</span>
			</h3>
			{#if layer.attributes.length === 0}
				<p class="text-sm text-muted">No Attributes.</p>
			{:else}
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-attributes">
					{#each layer.attributes as attribute (attribute.key)}
						{@const counts = tally(attribute)}
						<li class="grid gap-1.5 py-3 text-sm">
							<div class="flex flex-wrap items-baseline gap-x-2">
								<span class="font-semibold">{attribute.label}</span>
								<span class="key">{attribute.key}</span>
								<span class="text-muted">{attribute.kind}</span>
							</div>
							<Markdown source={attribute.rubric} empty="No rubric." />
							<p class="text-xs text-muted">
								Held by {attribute.held}
								{attribute.held === 1 ? 'Labour' : 'Labours'}, {attribute.stale} stale
							</p>
							{#if counts.length > 0}
								<ul class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs" data-testid="agent-counts">
									{#each counts as entry (entry.key)}
										<li><span class="text-muted">{entry.label}</span> {entry.count}</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="grid gap-1" aria-labelledby="agent-sentiment-heading">
			<h3 id="agent-sentiment-heading" class="label">Sentiment</h3>
			{#if layer.sentiment.length === 0}
				<p class="text-sm text-muted">No Sentiment.</p>
			{:else}
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-sentiment">
					{#each layer.sentiment as entry (entry.key)}
						<li class="flex flex-wrap items-baseline gap-x-2 py-2 text-sm">
							<span class="font-semibold">{entry.label}</span>
							<span class="key">{entry.key}</span>
							<span>volume {entry.volume.toFixed(1)}</span>
							<span>mood {signed(entry.mood)}</span>
						</li>
					{/each}
				</ul>
				{#if layer.moreSentiment > 0}
					<p class="text-sm text-muted">and {layer.moreSentiment} more.</p>
				{/if}
			{/if}
		</section>

		<section class="grid gap-1" aria-labelledby="agent-unfiled-heading">
			<h3 id="agent-unfiled-heading" class="label">Unfiled keys</h3>
			{#if layer.unfiled.length === 0}
				<p class="text-sm text-muted">No unfiled keys.</p>
			{:else}
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-unfiled">
					{#each layer.unfiled as entry (entry.rawKey)}
						<li class="flex flex-wrap items-baseline gap-x-2 py-2 text-sm">
							<span class="key">{entry.rawKey}</span>
							<span>volume {entry.volume.toFixed(1)}</span>
							<span class="text-muted">{entry.count} {entry.count === 1 ? 'Pulse' : 'Pulses'}</span>
						</li>
					{/each}
				</ul>
				{#if layer.moreUnfiled > 0}
					<p class="text-sm text-muted">and {layer.moreUnfiled} more.</p>
				{/if}
			{/if}
		</section>
	{/snippet}
</AgentPanel>
