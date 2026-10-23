import { uniqueName } from './support/http.ts';
import { connectMcp, expect, test, uniqueRealmKey, type Mcp } from './fixtures/mcp.ts';

async function agentClient(admin: Mcp, prefix: string) {
	const username = uniqueName(prefix);
	await admin.ok('create_agent_user', { username, displayName: prefix });
	const { token } = await admin.ok('create_api_token', { user: username, name: 'e2e' });
	return { username, mcp: await connectMcp(token) };
}

test.describe('the agent layer over MCP', () => {
	// One flow, as a team's agents would live it: the artist's agent sets up the
	// Realm's vocabulary and appraises its Labours, a feeder reports what players
	// say, and the artist's agent asks for its biggest win, picks it and sees its
	// Affinity move. The server runs without the embedding model, so `similarity`
	// counts as missing throughout.
	test('defines, appraises, pulses, surveys and reports outcomes', async ({ mcp: admin }) => {
		const artist = await agentClient(admin, 'artist');
		const feeder = await agentClient(admin, 'feeder');
		try {
			const { mcp } = artist;
			const realm = uniqueRealmKey();
			await mcp.ok('create_realm', { name: 'Stormspire', key: realm });
			// The feeder reports into the Realm as an editor, once it accepts the Offer.
			await mcp.ok('offer_membership', { realm, user: feeder.username, role: 'editor' });
			await feeder.mcp.ok('accept_offer', { realm });

			const impact = await mcp.ok('define_attribute', {
				realm,
				key: 'impact',
				kind: 'scale',
				label: 'Impact',
				rubric: '1 is cosmetic; 5 changes how the game plays.',
				spec: { min: 1, max: 5 }
			});
			expect(impact.attribute).toMatchObject({ key: 'impact', kind: 'scale' });
			await mcp.ok('define_attribute', {
				realm,
				key: 'effort',
				kind: 'scale',
				label: 'Effort',
				rubric: '1 is an afternoon; 5 is a month.',
				spec: { min: 1, max: 5 }
			});
			const area = await mcp.ok('define_attribute', {
				realm,
				key: 'area',
				kind: 'tags',
				label: 'Area',
				rubric: 'The part of the game it is about.',
				spec: {
					members: ['boss', 'vfx', 'ui', 'backend'].map((key) => ({ key, label: key }))
				}
			});
			expect(area.version).toBeGreaterThan(impact.version);

			const vfx = await mcp.ok('define_skill', {
				key: 'vfx',
				label: 'VFX',
				rubric: '1 tweaks a preset; 5 owns the look of a fight.'
			});
			expect(vfx.skill).toMatchObject({ key: 'vfx', label: 'VFX' });
			const held = await mcp.ok('set_skills', { user: 'me', skills: { vfx: 4 } });
			expect(held).toEqual({ user: artist.username, skills: { vfx: 4 } });
			const { skills } = await mcp.ok('list_skills');
			expect(skills.find((skill: { key: string }) => skill.key === 'vfx').holders).toBeGreaterThan(
				0
			);

			const create = async (title: string, description: string) =>
				(await mcp.ok('create_labour', { realm, title, description })).labour.key as string;
			const glow = await create(
				'VFX: wind-up glow on boss slams',
				'Emissive build-up before the boss slam so players can read it.'
			);
			const sponge = await create(
				'Bosses feel like bullet sponges',
				'Forum thread: boss fights take too many hits.'
			);
			const design = await create(
				'Telegraph feedback pass',
				'Clearer boss wind-ups give players decision moments.'
			);
			const typo = await create(
				'Settings screen typo',
				'The brightness label is missing a letter.'
			);
			const oauth = await create('OAuth token refresh fails', 'Login loses its refresh token.');

			const unappraised = await mcp.ok('list_unappraised', { realm });
			expect(unappraised.total).toBe(5);
			expect(unappraised.nextOffset).toBeNull();
			expect(unappraised.labours.map((item: { reason: string }) => item.reason)).toEqual(
				Array(5).fill('unappraised')
			);

			const stampOf = async (labour: string) => {
				const appraisal = await mcp.ok('get_appraisal', { labour });
				expect(appraisal.unappraised).toBe(true);
				return appraisal.contentHash as string;
			};
			const stamps = {
				glow: await stampOf(glow),
				sponge: await stampOf(sponge),
				design: await stampOf(design),
				typo: await stampOf(typo)
			};

			await mcp.ok('add_comment', { labour: typo, body: 'Also the contrast label.' });

			const appraised = await mcp.ok('appraise', {
				labours: [
					{
						labour: glow,
						brief: 'Glow effect that telegraphs the boss slam.',
						values: { impact: 4, effort: 2, area: ['boss', 'vfx'] },
						needs: { vfx: 3 },
						links: [{ type: 'blocks', from: design }],
						stamp: stamps.glow
					},
					{
						labour: sponge,
						brief: 'Players say boss fights feel like bullet sponges.',
						values: { impact: 5, effort: 3, area: ['boss'] },
						links: [{ type: 'evidence', to: design }],
						stamp: stamps.sponge
					},
					{
						labour: design,
						brief: 'Design: readable boss wind-ups.',
						values: { impact: 4, effort: 4, area: ['boss'] },
						stamp: stamps.design
					},
					{
						labour: typo,
						brief: 'Typo in settings.',
						values: { impact: 1, effort: 1, area: ['ui'] },
						stamp: stamps.typo
					}
				]
			});
			expect(appraised.appraised).toEqual([
				{ labour: glow, stamped: true },
				{ labour: sponge, stamped: true },
				{ labour: design, stamped: true },
				{ labour: typo, stamped: false }
			]);

			await mcp.ok('update_labour', {
				labour: design,
				description: 'Clearer boss wind-ups give players decision moments. The warden sweep too.'
			});

			const afterAppraisal = await mcp.ok('list_unappraised', { realm });
			expect(afterAppraisal.total).toBe(3);
			const reasons = afterAppraisal.labours.map((item: { labour: string; reason: string }) => [
				item.labour,
				item.reason
			]);
			expect(Object.fromEntries(reasons)).toEqual({
				[typo]: 'unappraised',
				[oauth]: 'unappraised',
				[design]: 'content'
			});
			expect(reasons.at(-1)).toEqual([design, 'content']);
			expect(await mcp.ok('get_appraisal', { labour: design })).toMatchObject({
				unappraised: false,
				stale: true
			});

			const read = await mcp.ok('get_appraisal', { labour: glow });
			expect(read).toMatchObject({
				brief: 'Glow effect that telegraphs the boss slam.',
				unappraised: false,
				stale: false,
				needs: [{ skill: 'vfx', level: 3 }],
				links: [{ type: 'blocks', from: design, to: glow }]
			});
			expect(read.values.map((value: { key: string }) => value.key).sort()).toEqual([
				'area',
				'effort',
				'impact'
			]);

			const pulses = await feeder.mcp.ok('pulse', {
				realm,
				pulses: [
					{
						key: 'area:boss',
						amount: 6,
						mood: -0.9,
						note: 'Bosses are bullet sponges, 40 upvotes',
						ref: 'forum-1',
						evidence: [{ href: 'https://forum.example/t/1', label: 'Forum' }, { labour: sponge }]
					},
					{
						key: 'area:boss',
						amount: 6,
						mood: -0.9,
						note: 'Bosses are bullet sponges, 40 upvotes',
						ref: 'forum-1'
					},
					{ key: 'area:ui', amount: 2, mood: -0.3, note: 'Labels are hard to read' },
					{ key: 'loot', amount: 1, mood: 0.5, note: 'Loot drops feel good' }
				]
			});
			expect(
				pulses.pulses.map((p: { index: number; status: string }) => [p.index, p.status])
			).toEqual([
				[0, 'filed'],
				[1, 'skipped'],
				[2, 'filed'],
				[3, 'unfiled']
			]);
			expect(pulses.pulses[1].id).toBe(pulses.pulses[0].id);

			const sentiment = await mcp.ok('get_sentiment', { realm });
			expect(sentiment.keys.map((entry: { key: string }) => entry.key)).toEqual([
				'area:boss',
				'area:ui'
			]);
			const boss = sentiment.keys[0];
			expect(boss).toMatchObject({ realm, key: 'area:boss' });
			expect(boss.mood).toBeCloseTo(-0.9);
			// One Pulse of amount 6, moments old, against the default loudness of 5.
			expect(boss.v).toBeCloseTo(6 / (6 + 5), 2);
			expect(boss.pulses).toHaveLength(1);
			expect(boss.pulses[0]).toMatchObject({
				note: 'Bosses are bullet sponges, 40 upvotes',
				author: feeder.username,
				evidence: [{ href: 'https://forum.example/t/1', label: 'Forum' }, { labour: sponge }]
			});
			expect(sentiment.unfiled).toMatchObject([
				{ rawKey: 'loot', count: 1, newest: { note: 'Loot drops feel good' } }
			]);

			const weights = { skill_fit: 3, impact: 2, pain: 1, effort: -1 };
			const asked = await mcp.ok('survey', { realm, weights, temperature: 0 });
			expect(asked.survey).toEqual(expect.any(Number));
			const keys = asked.results.map((item: { key: string }) => item.key);
			expect(keys.slice(0, 3)).toEqual([glow, sponge, design]);
			expect([...keys].sort()).toEqual([glow, sponge, design, typo, oauth].sort());
			expect(asked.results[0]).toMatchObject({
				key: glow,
				path: `/l/${glow}`,
				title: 'VFX: wind-up glow on boss slams',
				realm,
				state: 'todo',
				assignee: null,
				brief: 'Glow effect that telegraphs the boss slam.'
			});
			expect(asked.results[0].contributions.skill_fit).toBeCloseTo(3);
			expect(asked.results[0].contributions.impact).toBeCloseTo(1.5);
			expect(asked.results[0].contributions.pain).toBeGreaterThan(0.4);
			expect(asked.results[0].score).toBeGreaterThan(asked.results[1].score);
			expect(asked.sentiment.map((entry: { key: string }) => entry.key)).toEqual([
				'area:boss',
				'area:ui'
			]);
			expect(asked.sentiment[0]).toMatchObject({ realm, key: 'area:boss' });
			expect(asked.sentiment[0].pulses[0].note).toBe('Bosses are bullet sponges, 40 upvotes');
			expect(asked.coverage).toMatchObject({ candidates: 5, unappraised: 2, stale: 1 });
			expect(asked.ignored).toEqual([]);

			const unembedded = await mcp.ok('survey', {
				realm,
				query: 'boss slam',
				weights: { keywords: 1, similarity: 1 },
				temperature: 0
			});
			expect(unembedded.results[0].key).toBe(glow);
			expect(unembedded.coverage.missing.similarity).toBe(5);
			expect(unembedded.coverage.unembedded).toBe(5);

			const noAffinity = await mcp.ok('get_sentiment', { user: 'me' });
			expect(noAffinity.keys).toEqual([]);
			const unmoved = await mcp.ok('survey', {
				realm,
				weights: { affinity: 1 },
				temperature: 0
			});
			expect(unmoved.results.map((result: { score: number }) => result.score)).toEqual(
				Array(5).fill(0)
			);

			const outcomes = await mcp.ok('report_outcomes', {
				survey: asked.survey,
				outcomes: [
					{ labour: glow, verdict: 'picked' },
					{ labour: typo, verdict: 'skipped' }
				]
			});
			expect(outcomes.outcomes).toEqual([
				{ labour: glow, verdict: 'picked', recorded: true },
				{ labour: typo, verdict: 'skipped', recorded: true }
			]);
			const repeated = await mcp.ok('report_outcomes', {
				survey: asked.survey,
				outcomes: [{ labour: glow, verdict: 'picked' }]
			});
			expect(repeated.outcomes).toEqual([{ labour: glow, verdict: 'picked', recorded: false }]);
			const affinity = await mcp.ok('get_sentiment', { user: 'me' });
			const moods = Object.fromEntries(
				affinity.keys.map((entry: { realm: string; key: string; mood: number }) => [
					`${entry.realm}/${entry.key}`,
					entry.mood
				])
			);
			expect(moods[`${realm}/area:boss`]).toBe(1);
			expect(moods[`${realm}/area:vfx`]).toBe(1);
			expect(moods[`${realm}/area:ui`]).toBe(-1);
			expect(affinity.unfiled).toEqual([]);

			const followed = await mcp.ok('survey', {
				realm,
				weights: { ...weights, affinity: 2 },
				temperature: 0
			});
			const item = (key: string) =>
				followed.results.find((result: { key: string }) => result.key === key);
			expect(followed.results[0].key).toBe(glow);
			expect(item(glow).contributions.affinity).toBeGreaterThan(0);
			expect(item(typo).contributions.affinity).toBeLessThan(0);

			const late = await create('Added after the Survey', 'Not among any results.');
			const refused = await mcp.call('report_outcomes', {
				survey: asked.survey,
				outcomes: [{ labour: late, verdict: 'picked' }]
			});
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain('is not among');
		} finally {
			await artist.mcp.close();
			await feeder.mcp.close();
		}
	});
});
