import MarkdownIt from 'markdown-it';

// `html: false` escapes every raw HTML tag, and markdown-it's validateLink drops javascript:,
// vbscript:, file: and non-image data: URLs. Keep both: descriptions are rendered with {@html}.
const md = new MarkdownIt({ html: false, linkify: true });

const defaultLinkOpen =
	md.renderer.rules.link_open ??
	((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

const LINK = 'rel="noopener noreferrer nofollow" target="_blank"';

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

export function renderMarkdown(source: string): string {
	return md.render(source);
}
