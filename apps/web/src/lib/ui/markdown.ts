import MarkdownIt from 'markdown-it';
import type { StateInline } from 'markdown-it';
import { normalizePath } from './scroll-path.ts';

const LINK = 'rel="noopener noreferrer nofollow" target="_blank"';

// `html: false` escapes every raw HTML tag, and markdown-it's validateLink drops javascript:,
// vbscript:, file: and non-image data: URLs. Keep both: descriptions are rendered with {@html}.
function base(): MarkdownIt {
	const md = new MarkdownIt({ html: false, linkify: true });

	const defaultLinkOpen =
		md.renderer.rules.link_open ??
		((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
		tokens[idx].attrSet('target', '_blank');
		return defaultLinkOpen(tokens, idx, options, env, self);
	};

	// An image would make every viewer fetch it, telling its host who looked: link to it instead.
	md.renderer.rules.image = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		const src = token.attrGet('src') ?? '';
		const alt = self.renderInlineAsText(token.children ?? [], options, env);
		const { escapeHtml } = md.utils;
		return `<a href="${escapeHtml(src)}" ${LINK}>${escapeHtml(alt || src)}</a>`;
	};
	return md;
}

const md = base();

export function renderMarkdown(source: string): string {
	return md.render(source);
}

export type ScrollLink = { target: string; label: string | null };

// Where a Scroll link goes: `missing` when no Scroll holds the target, so it offers to create one.
export type ScrollTarget = { href: string; title: string; missing: boolean };
export type ResolveScroll = (target: string) => ScrollTarget;

const WIKI = /^\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/;

function scrollLinkRule(state: StateInline, silent: boolean): boolean {
	if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) {
		return false;
	}
	const match = WIKI.exec(state.src.slice(state.pos));
	const target = match && normalizePath(match[1]);
	if (!match || !target) return false;
	if (!silent) {
		const token = state.push('scroll_link', '', 0);
		token.meta = { target, label: match[2]?.trim() || null } satisfies ScrollLink;
	}
	state.pos += match[0].length;
	return true;
}

const scrollMd = base();
scrollMd.inline.ruler.before('link', 'scroll_link', scrollLinkRule);
scrollMd.renderer.rules.scroll_link = (tokens, idx, _options, env: { resolve?: ResolveScroll }) => {
	const { target, label } = tokens[idx].meta as ScrollLink;
	const { escapeHtml } = scrollMd.utils;
	const found = env.resolve?.(target) ?? { href: target, title: target, missing: true };
	const missing = found.missing ? ' class="scroll-missing" data-missing' : '';
	return `<a href="${escapeHtml(found.href)}"${missing}>${escapeHtml(label ?? found.title)}</a>`;
};

export function renderScroll(source: string, resolve: ResolveScroll): string {
	return scrollMd.render(source, { resolve });
}

// The Scroll links a body holds, in order, each target once.
export function scrollLinks(source: string): ScrollLink[] {
	const found = new Map<string, ScrollLink>();
	for (const block of scrollMd.parse(source, {})) {
		for (const token of block.children ?? []) {
			if (token.type !== 'scroll_link') continue;
			const link = token.meta as ScrollLink;
			if (!found.has(link.target)) found.set(link.target, link);
		}
	}
	return [...found.values()];
}
