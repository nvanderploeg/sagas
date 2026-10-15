import { cubicOut } from 'svelte/easing';
import { crossfade, type TransitionConfig } from 'svelte/transition';
import { motion } from './motion.svelte.ts';

// Cards in different lists that share these transitions fly from one list to the other.
export function cardFlight() {
	const [send, receive] = crossfade({
		duration: (distance) => motion.ms(Math.min(520, 240 + distance / 3)),
		easing: cubicOut,
		fallback: () => ({
			duration: motion.ms(200),
			easing: cubicOut,
			css: (t) => `opacity: ${t}; transform: scale(${0.96 + 0.04 * t})`
		})
	});

	type Params = { key: number | string; instant?: boolean; from?: DOMRect | null };

	const leave = (node: Element, params: Params) =>
		params.instant ? { duration: 0 } : send(node, { key: params.key });

	const arrive = (node: Element, params: Params) => {
		if (params.instant) return { duration: 0 };
		if (params.from) return land(node, params.from);
		return receive(node, { key: params.key });
	};

	return { leave, arrive };
}

export function land(node: Element, from: DOMRect): TransitionConfig {
	const to = node.getBoundingClientRect();
	const dx = from.left - to.left;
	const dy = from.top - to.top;
	return {
		duration: motion.ms(260),
		easing: cubicOut,
		css: (t, u) =>
			`transform: translate(${dx * u}px, ${dy * u}px) rotate(${2 * u}deg) scale(${1 + 0.03 * u}); z-index: 10; position: relative;`
	};
}
