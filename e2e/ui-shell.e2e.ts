import { expect, test } from './fixtures/ui.ts';

test.describe('theme', () => {
	test('is one radio group: one tab stop, arrow keys choose', async ({ page }) => {
		await page.goto('/');
		const group = page.getByRole('radiogroup', { name: 'Theme' });
		const radio = (name: string) => group.getByRole('radio', { name });
		await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(radio('System')).toHaveAttribute('tabindex', '0');

		await radio('System').focus();
		await page.keyboard.press('ArrowRight');
		await expect(radio('Light')).toBeFocused();
		await expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.keyboard.press('ArrowDown');
		await expect(radio('Dark')).toBeFocused();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.keyboard.press('ArrowRight');
		await expect(radio('System')).toBeFocused();
		await expect(page.locator('html')).not.toHaveAttribute('data-theme');
		await page.keyboard.press('ArrowLeft');
		await expect(radio('Dark')).toBeFocused();
		await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(radio('Dark')).toHaveAttribute('tabindex', '0');

		await page.keyboard.press('Tab');
		await expect(group.locator(':focus')).toHaveCount(0);
		await page.keyboard.press('Shift+Tab');
		await expect(radio('Dark')).toBeFocused();
	});
});
