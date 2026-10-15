import MarkdownIt from 'markdown-it';

// `html: false` escapes every raw HTML tag, and markdown-it's validateLink drops javascript:,
// vbscript:, file: and non-image data: URLs. Keep both: descriptions are rendered with {@html}.
const md = new MarkdownIt({ html: false, linkify: true });

const defaultLinkOpen =
	md.renderer.rules.link_open ??
	((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
	tokens[idx].attrSet('target', '_blank');
	return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
	return md.render(source);
}
