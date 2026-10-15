import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
	it('renders Markdown', () => {
		expect(renderMarkdown('**bold** and `code`')).toBe(
			'<p><strong>bold</strong> and <code>code</code></p>\n'
		);
	});

	it('escapes raw HTML instead of injecting it', () => {
		const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;');
	});

	it('drops script URLs from links and images', () => {
		const html = renderMarkdown('[a](javascript:alert(1)) ![b](vbscript:x) [c](data:text/html,x)');
		expect(html).not.toMatch(/href="(javascript|vbscript|data):/);
		expect(html).not.toMatch(/src="vbscript:/);
	});

	it('opens links in a new tab without handing over the opener', () => {
		expect(renderMarkdown('<https://example.com>')).toContain(
			'<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">'
		);
	});
});
