export type Target = { group: number; index: number };

export type Lifted = {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type DragHooks = {
	locate(x: number, y: number): Target | null;
	start(id: number): void;
	move(target: Target): void;
	// `from` is where the lifted card was let go, for the landing animation.
	drop(from: DOMRect): void;
	cancel(): void;
	scroller?: () => HTMLElement | null;
};

const THRESHOLD = 6;
const EDGE = 56;

// A pointer drag that lifts a card out of a list and follows the pointer with it. Mouse and pen
// drag from anywhere on the card; touch only from a handle, so a finger still scrolls the board.
export class PointerDrag {
	lifted = $state<Lifted | null>(null);
	#hooks: DragHooks;
	#pending: { id: number; element: HTMLElement; x: number; y: number; pointer: number } | null =
		null;
	#offset = { x: 0, y: 0 };
	#pointer = { x: 0, y: 0 };
	#target: Target | null = null;
	#frame = 0;
	#cleanup: (() => void) | null = null;

	constructor(hooks: DragHooks) {
		this.#hooks = hooks;
	}

	get active(): boolean {
		return this.lifted !== null;
	}

	begin(event: PointerEvent, id: number, element: HTMLElement, fromHandle = false): void {
		if (event.button !== 0 || this.#pending || this.lifted) return;
		if (event.pointerType === 'touch' && !fromHandle) return;
		if (fromHandle) event.preventDefault();
		this.#pending = { id, element, x: event.clientX, y: event.clientY, pointer: event.pointerId };
		const move = (e: PointerEvent) => this.#onMove(e);
		const up = (e: PointerEvent) => this.#onUp(e);
		const cancel = () => this.#finish(false);
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.lifted) {
				e.preventDefault();
				this.#finish(false);
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', key);
		this.#cleanup = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('keydown', key);
		};
	}

	#onMove(event: PointerEvent): void {
		const pending = this.#pending;
		if (!pending || event.pointerId !== pending.pointer) return;
		this.#pointer = { x: event.clientX, y: event.clientY };
		if (!this.lifted) {
			if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < THRESHOLD) return;
			const rect = pending.element.getBoundingClientRect();
			this.#offset = { x: pending.x - rect.left, y: pending.y - rect.top };
			this.lifted = {
				id: pending.id,
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height
			};
			document.documentElement.classList.add('dragging');
			this.#hooks.start(pending.id);
			this.#tick();
		}
		event.preventDefault();
		this.lifted = {
			...this.lifted,
			x: event.clientX - this.#offset.x,
			y: event.clientY - this.#offset.y
		};
	}

	#tick = (): void => {
		if (!this.lifted) return;
		this.#autoscroll();
		const target = this.#hooks.locate(this.#pointer.x, this.#pointer.y);
		if (target && (target.group !== this.#target?.group || target.index !== this.#target?.index)) {
			this.#target = target;
			this.#hooks.move(target);
		}
		this.#frame = requestAnimationFrame(this.#tick);
	};

	#autoscroll(): void {
		const { x, y } = this.#pointer;
		const scroller = this.#hooks.scroller?.();
		if (scroller) {
			const r = scroller.getBoundingClientRect();
			if (x < r.left + EDGE) scroller.scrollLeft -= Math.ceil((r.left + EDGE - x) / 4);
			else if (x > r.right - EDGE) scroller.scrollLeft += Math.ceil((x - (r.right - EDGE)) / 4);
		}
		if (y < EDGE) window.scrollBy(0, -Math.ceil((EDGE - y) / 4));
		else if (y > window.innerHeight - EDGE) {
			window.scrollBy(0, Math.ceil((y - (window.innerHeight - EDGE)) / 4));
		}
	}

	#onUp(event: PointerEvent): void {
		if (event.pointerId !== this.#pending?.pointer) return;
		if (this.lifted) {
			const target = this.#hooks.locate(event.clientX, event.clientY);
			if (target) this.#hooks.move(target);
			// The release would click whatever sits under the pointer.
			const swallow = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
			};
			window.addEventListener('click', swallow, { capture: true, once: true });
			setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
		}
		this.#finish(true);
	}

	#finish(dropped: boolean): void {
		const lifted = this.lifted;
		this.#cleanup?.();
		this.#cleanup = null;
		this.#pending = null;
		this.#target = null;
		cancelAnimationFrame(this.#frame);
		document.documentElement.classList.remove('dragging');
		if (!lifted) return;
		this.lifted = null;
		if (dropped) {
			this.#hooks.drop(new DOMRect(lifted.x, lifted.y, lifted.width, lifted.height));
		} else this.#hooks.cancel();
	}
}
