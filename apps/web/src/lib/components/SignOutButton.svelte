<script lang="ts">
	import { page } from '$app/state';

	let { class: className = 'btn btn-quiet' }: { class?: string } = $props();

	async function signOut(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		try {
			const { firebaseSignOut } = await import('#lib/ui/firebase.ts');
			await firebaseSignOut(page.data.firebase);
		} catch {
			// The server clears the session either way.
		}
		form.submit();
	}
</script>

<form method="POST" action="/logout" onsubmit={signOut}>
	<button type="submit" class={className}>Sign out</button>
</form>
