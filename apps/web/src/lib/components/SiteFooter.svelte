<script lang="ts">
	const repo = 'https://github.com/nvanderploeg/sagas';
	const hash = __GIT_HASH__;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- every href is an external URL -->
<footer
	class="mx-auto flex max-w-6xl flex-wrap justify-between gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted"
	data-testid="site-footer"
>
	<nav class="contents" aria-label="About sagas">
		<a
			class="underline-offset-4 hover:text-ink hover:underline"
			href={repo}
			target="_blank"
			rel="noopener noreferrer">github.com/nvanderploeg/sagas</a
		>
		<a
			class="underline-offset-4 hover:text-ink hover:underline"
			href="https://nanzero.com"
			target="_blank"
			rel="noopener noreferrer">Powered by <strong>Nanzero</strong></a
		>
		<a
			class="underline-offset-4 hover:text-ink hover:underline"
			href="https://ko-fi.com/skadiarchery"
			target="_blank"
			rel="noopener noreferrer"
			data-testid="kofi-link">☕ Buy me a coffee</a
		>
	</nav>
	<span class="tabular-nums" data-testid="build-stamp"
		>v{__APP_VERSION__} ·
		{#if hash === 'unknown'}{hash}{:else}<a
				class="underline-offset-4 hover:text-ink hover:underline"
				href="{repo}/commit/{hash}"
				target="_blank"
				rel="noopener noreferrer"><code>{hash}</code></a
			>{/if}</span
	>
</footer>
