import type { Attachment } from 'svelte/attachments';

const THRESHOLD = 4;
const SKIP = 'a, button, input, select, textarea, label, summary, [data-card]';

// Mouse and pen drag empty space to scroll the attached element sideways and, when `vertical`
// finds one under the press, that element up and down. Touch is left to native scrolling.
export function pan(vertical?: (target: Element) => HTMLElement | null): Attachment<HTMLElement> {
	return (scroller) => {
		function down(event: PointerEvent) {
			if (event.button !== 0 || event.pointerType === 'touch') return;
			const target = event.target;
			if (!(target instanceof HTMLElement) || target.closest(SKIP)) return;
			// A press on a scrollbar belongs to the scrollbar.
			const scrolls =
				target.scrollWidth > target.clientWidth || target.scrollHeight > target.clientHeight;
			if (scrolls && (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight))
				return;
			event.preventDefault();

			const column = vertical?.(target) ?? null;
			const start = { x: event.clientX, y: event.clientY };
			const from = { left: scroller.scrollLeft, top: column?.scrollTop ?? 0 };
			let moved = false;

			const move = (e: PointerEvent) => {
				if (e.pointerId !== event.pointerId) return;
				const dx = e.clientX - start.x;
				const dy = e.clientY - start.y;
				if (!moved) {
					if (Math.hypot(dx, dy) < THRESHOLD) return;
					moved = true;
					document.documentElement.classList.add('panning');
				}
				scroller.scrollLeft = from.left - dx;
				if (column) column.scrollTop = from.top - dy;
			};
			const up = (e: PointerEvent) => {
				if (e.pointerId !== event.pointerId) return;
				stop();
				if (!moved) return;
				// The release would click whatever sits under the pointer.
				const swallow = (c: MouseEvent) => {
					c.preventDefault();
					c.stopPropagation();
				};
				window.addEventListener('click', swallow, { capture: true, once: true });
				setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
			};
			const stop = () => {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
				window.removeEventListener('pointercancel', stop);
				document.documentElement.classList.remove('panning');
				cleanup = null;
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
			window.addEventListener('pointercancel', stop);
			cleanup = stop;
		}

		let cleanup: (() => void) | null = null;
		scroller.addEventListener('pointerdown', down);
		return () => {
			scroller.removeEventListener('pointerdown', down);
			cleanup?.();
		};
	};
}
