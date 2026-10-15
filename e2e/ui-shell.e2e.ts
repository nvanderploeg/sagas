import { expect, live, test } from './fixtures/ui.ts';

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

test.describe('session', () => {
	test('a Stream refused for a lost session sends the user to sign in, then back', async ({
		other,
		ui
	}) => {
		const p = ui.project();
		const { page, context, person } = other;
		await page.goto(`/p/${p.key}?filter=1`);
		await live(page);

		const tab = await context.newPage();
		await tab.goto('/account');
		await tab.getByRole('button', { name: 'Sign out' }).click();
		await expect(tab).toHaveURL(/\/login$/);
		await tab.close();

		const back = encodeURIComponent(`/p/${p.key}?filter=1`);
		await expect(page).toHaveURL(new RegExp(`/login\\?next=${back}$`), { timeout: 10_000 });
		await page.getByLabel('Username').fill(person.username);
		await page.getByLabel('Password').fill(person.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(new RegExp(`/p/${p.key}\\?filter=1$`));
		await live(page);
	});

	test('signing in never follows a return path off the site', async ({ other }) => {
		const { page, context, person } = other;
		await context.clearCookies();
		for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
			await page.goto(`/login?next=${encodeURIComponent(next)}`);
			await page.getByLabel('Username').fill(person.username);
			await page.getByLabel('Password').fill(person.password);
			await page.getByRole('button', { name: 'Sign in' }).click();
			await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
			await context.clearCookies();
		}
	});
});
