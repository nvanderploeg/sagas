<script lang="ts">
	let { value, label, note }: { value: string; label: string; note: string } = $props();

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => (copied = false), 1800);
		} catch {
			copied = false;
		}
	}
</script>

<div
	class="grid gap-2 rounded-xl border border-gold/60 bg-gold/10 p-3"
	role="status"
	data-testid="secret"
>
	<p class="text-sm font-semibold">{label}</p>
	<div class="flex flex-wrap items-center gap-2">
		<code class="min-w-0 flex-1 rounded-lg bg-panel px-2 py-1.5 font-mono text-sm break-all"
			>{value}</code
		>
		<button type="button" class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
	</div>
	<p class="text-xs text-muted">{note}</p>
</div>
