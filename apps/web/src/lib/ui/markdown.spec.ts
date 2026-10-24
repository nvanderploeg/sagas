import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderScroll, scrollLinks } from './markdown.ts';

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

	it('renders images as plain links, so viewing a description fetches nothing', () => {
		const html = renderMarkdown('![a <b> chart](https://tracker.example/p.png "t") ![](/x.png)');
		expect(html).not.toContain('<img');
		expect(html).toContain(
			'<a href="https://tracker.example/p.png" rel="noopener noreferrer nofollow" target="_blank">a &lt;b&gt; chart</a>'
		);
		expect(html).toContain('>/x.png</a>');
	});

	it('opens links in a new tab without handing over the opener', () => {
		expect(renderMarkdown('<https://example.com>')).toContain(
			'<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">'
		);
	});
});

describe('renderScroll', () => {
	const resolve = (target: string) =>
		target === 'ops/release'
			? { href: '/r/AM/s/ops/release', title: 'Release <process>', missing: false }
			: { href: `/r/AM/s/${target}`, title: target, missing: true };

	it('links a Scroll by its title, or by the label given', () => {
		expect(renderScroll('See [[Ops/Release]] and [[ops/release|the steps]].', resolve)).toBe(
			'<p>See <a href="/r/AM/s/ops/release">Release &lt;process&gt;</a> and ' +
				'<a href="/r/AM/s/ops/release">the steps</a>.</p>\n'
		);
	});

	it('marks a link to no Scroll as one that creates it', () => {
		expect(renderScroll('[[New page]]', resolve)).toContain(
			'<a href="/r/AM/s/new-page" class="scroll-missing" data-missing>new-page</a>'
		);
	});

	it('leaves Scroll links in code alone', () => {
		const html = renderScroll('`[[ops/release]]`\n\n    [[ops/release]]', resolve);
		expect(html).not.toContain('<a');
	});

	it('keeps raw HTML escaped', () => {
		expect(renderScroll('<b>x</b> [[a|<i>y</i>]]', resolve)).not.toMatch(/<(b|i)>/);
	});
});

describe('scrollLinks', () => {
	it('lists each normalized target once, outside code', () => {
		expect(
			scrollLinks('[[Ops/Release]] [[ops/release|again]] `[[skipped]]` [[ /a//b/ |B]] [[]] [[ |x]]')
		).toEqual([
			{ target: 'ops/release', label: null },
			{ target: 'a/b', label: 'B' }
		]);
	});
});
