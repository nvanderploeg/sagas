<script lang="ts">
	import { signed, type UserLayerData } from '#lib/ui/agent.ts';
	import AgentPanel from './AgentPanel.svelte';

	const empty = (layer: UserLayerData) => layer.skills.length === 0 && layer.affinity.length === 0;
</script>

<AgentPanel url="/api/agent/me" isEmpty={empty}>
	{#snippet body(layer: UserLayerData)}
		<section class="grid gap-1" aria-labelledby="agent-skills-heading">
			<h3 id="agent-skills-heading" class="label">Your Skills</h3>
			{#if layer.skills.length === 0}
				<p class="text-sm text-muted">No Skills.</p>
			{:else}
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-skills">
					{#each layer.skills as skill (skill.key)}
						<li class="flex flex-wrap items-baseline gap-x-2 py-2 text-sm">
							<span class="font-semibold">{skill.label}</span>
							<span class="key">{skill.key}</span>
							<span>level {skill.level}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="grid gap-1" aria-labelledby="agent-affinity-heading">
			<h3 id="agent-affinity-heading" class="label">Your Affinity</h3>
			{#if layer.affinity.length === 0}
				<p class="text-sm text-muted">No Affinity.</p>
			{:else}
				<ul class="divide-y divide-line border-t border-line" data-testid="agent-affinity">
					{#each layer.affinity as entry (`${entry.realm}:${entry.key}`)}
						<li class="flex flex-wrap items-baseline gap-x-2 py-2 text-sm">
							<span class="key">{entry.realm}</span>
							<span class="font-semibold">{entry.label}</span>
							<span class="key">{entry.key}</span>
							<span>volume {entry.volume.toFixed(1)}</span>
							<span>mood {signed(entry.mood)}</span>
						</li>
					{/each}
				</ul>
				{#if layer.moreAffinity > 0}
					<p class="text-sm text-muted">and {layer.moreAffinity} more.</p>
				{/if}
			{/if}
		</section>
	{/snippet}
</AgentPanel>
