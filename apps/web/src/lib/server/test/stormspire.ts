import { vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { users } from '#lib/server/db/schema.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { createLabour } from '#lib/server/domain/labours.ts';
import { createRealmWithStates } from '#lib/server/domain/realms.ts';
import { listStates } from '#lib/server/domain/states.ts';
import { appraise, readAppraisal, type AppraiseItem } from '#lib/server/agent/appraisals.ts';
import { defineAttribute } from '#lib/server/agent/attributes.ts';
import { rebuildDerived } from '#lib/server/agent/derived.ts';
import { postPulses, type PulseInput } from '#lib/server/agent/sentiment.ts';
import { defineSkill, setSkills } from '#lib/server/agent/skills.ts';

export const STORMSPIRE_NOW = new Date('2026-03-10T12:00:00.000Z');

const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(STORMSPIRE_NOW.getTime() - days * DAY);

type Owner = 'ivy' | 'rook';
type Links = { type: 'evidence' | 'blocks' | 'relates'; to: LabourName }[];

type Spec = {
	title: string;
	owner: Owner;
	closed?: true;
	description: (key: (name: LabourName) => string) => string;
	brief: string;
	impact: number;
	effort: number;
	area?: string[];
	kind: 'report' | 'design' | 'task';
	needs?: Record<string, number>;
	links?: Links;
};

const NAMES = [
	'telegraph',
	'damagePhases',
	'inventoryLayout',
	'sponge',
	'dragon',
	'cantTell',
	'dodge',
	'stackCount',
	'glow',
	'anticipation',
	'hitStop',
	'hpRetune',
	'sortButton',
	'roar',
	'embers',
	'menuAnim',
	'oauth',
	'typo',
	'saveMigration',
	'iFrames'
] as const;

export type LabourName = (typeof NAMES)[number];

const LABOURS: Record<LabourName, Spec> = {
	telegraph: {
		title: 'Telegraph feedback pass: clearer boss wind-ups give players decision moments',
		owner: 'rook',
		description: () =>
			'Boss attacks read as a blur: the slam starts and lands inside the same 0.4s. Give every heavy attack a readable wind-up (glow, anticipation pose, audio cue) so the player can choose to dodge, block or trade. More decisions per fight, less standing in front of the dragon trading hits. Covers the dragon slam and the warden sweep.',
		brief:
			'Design for readable boss wind-ups: glow, anticipation pose and audio cue give players decision-making moments.',
		impact: 4,
		effort: 4,
		area: ['boss', 'combat', 'vfx', 'animation', 'audio'],
		kind: 'design',
		needs: { gameplay: 3, combat: 3 }
	},
	damagePhases: {
		title: 'Boss damage phases',
		owner: 'rook',
		description: () =>
			'Bosses take damage in phases: armour, then stagger windows where hits count for more. Players spend their attention on when to attack, not on how long the bar is. Pairs with the boss HP retune.',
		brief:
			'Design for phased boss damage: stagger windows reward timing, so fights are shorter and decisions matter.',
		impact: 4,
		effort: 4,
		area: ['boss', 'combat'],
		kind: 'design',
		needs: { gameplay: 4 }
	},
	inventoryLayout: {
		title: 'Inventory layout for small screens',
		owner: 'ivy',
		description: () =>
			'Rework the inventory grid so item icons and stack counts stay readable on the Steam Deck and on phones.',
		brief: 'Design for an inventory grid that stays readable on small screens.',
		impact: 2,
		effort: 3,
		area: ['ui'],
		kind: 'design',
		needs: { 'ui-art': 3 }
	},
	sponge: {
		title: 'Bosses feel like bullet sponges',
		owner: 'rook',
		description: () =>
			'Top thread on the forum this week, 40 upvotes. Boss fights take far too many hits to finish and the damage numbers do not feel like they matter. Three playtesters said they stopped dodging and just mashed attack. Mostly the dragon and the warden.',
		brief:
			'Players report boss fights feel like bullet sponges: long health bars and no sense of progress.',
		impact: 5,
		effort: 3,
		area: ['boss', 'combat'],
		kind: 'report',
		links: [
			{ type: 'evidence', to: 'telegraph' },
			{ type: 'evidence', to: 'damagePhases' }
		]
	},
	dragon: {
		title: 'The dragon fight drags on forever',
		owner: 'rook',
		description: () =>
			'Discord, three separate people this week: the dragon boss fight takes ten minutes and most of it is waiting for the next opening. Fun for the first two phases, then it drags.',
		brief: 'The dragon boss fight is too long; players lose interest after the second phase.',
		impact: 4,
		effort: 3,
		area: ['boss'],
		kind: 'report',
		links: [
			{ type: 'evidence', to: 'telegraph' },
			{ type: 'evidence', to: 'damagePhases' }
		]
	},
	cantTell: {
		title: "Can't tell when the boss is about to slam",
		owner: 'ivy',
		description: () =>
			'Playtest notes: the slam comes out of nowhere, I only know it hit me because my health dropped. No sound, no glow. Same for the warden sweep.',
		brief: 'Players cannot read the boss slam wind-up; hits feel unavoidable.',
		impact: 4,
		effort: 2,
		area: ['boss', 'animation', 'vfx'],
		kind: 'report',
		links: [{ type: 'evidence', to: 'telegraph' }]
	},
	dodge: {
		title: 'Dodge feels great since the i-frame change',
		owner: 'rook',
		description: () =>
			'Forum and Discord both: the roll finally feels fair and responsive after the longer i-frame window.',
		brief: 'Positive feedback: dodge roll feels responsive after the i-frame change.',
		impact: 2,
		effort: 1,
		area: ['combat'],
		kind: 'report'
	},
	stackCount: {
		title: 'Stack counts are unreadable in the inventory on the Deck',
		owner: 'ivy',
		description: () =>
			'Two Steam Deck players: the numbers on stacked items are tiny and sit on top of the icon.',
		brief: 'Inventory stack counts are too small to read on handheld screens.',
		impact: 3,
		effort: 2,
		area: ['ui'],
		kind: 'report',
		links: [{ type: 'evidence', to: 'inventoryLayout' }]
	},
	glow: {
		title: 'VFX: wind-up glow on boss slams',
		owner: 'ivy',
		description: (key) =>
			`Emissive build-up on the weapon plus a floor decal, 0.6s ramp, tuned for readability over the arena lighting. Timings come from the telegraph design (${key('telegraph')}).`,
		brief: 'Wind-up glow effect on boss slam attacks, timed to the telegraph design.',
		impact: 4,
		effort: 2,
		area: ['boss', 'vfx'],
		kind: 'task',
		needs: { vfx: 3 },
		links: [{ type: 'relates', to: 'telegraph' }]
	},
	anticipation: {
		title: 'Animation: anticipation frames for the dragon slam',
		owner: 'ivy',
		description: () =>
			'Add a 12 frame anticipation pose before the dragon slam: rear back, hold, then drop. The pose has to read from the default camera.',
		brief: 'Anticipation animation for the dragon slam so the attack is readable.',
		impact: 4,
		effort: 3,
		area: ['boss', 'animation'],
		kind: 'task',
		needs: { animation: 3 }
	},
	hitStop: {
		title: 'Hit-stop on heavy attacks',
		owner: 'rook',
		description: () =>
			'Freeze both actors 3 to 5 frames on heavy hits and add a small camera kick. Make the frame count tunable per weapon.',
		brief: 'Short hit-stop and camera kick on heavy attacks to sell impact.',
		impact: 3,
		effort: 2,
		area: ['combat'],
		kind: 'task',
		needs: { gameplay: 3, combat: 3 }
	},
	hpRetune: {
		title: 'Retune boss HP and damage curve',
		owner: 'rook',
		description: () =>
			'Cut boss health by about a third and move the lost time into the phase transitions. Spreadsheet is in the design folder.',
		brief: 'Retune boss health and damage values to shorten fights.',
		impact: 5,
		effort: 1,
		area: ['boss', 'combat'],
		kind: 'task',
		needs: { combat: 3, gameplay: 2 }
	},
	sortButton: {
		title: 'UI: inventory sort button overlaps the stack count',
		owner: 'ivy',
		description: () =>
			'On 16:9 the sort button sits on top of the stack count of the last slot. Move it into the header.',
		brief: 'Inventory sort button overlaps the stack count; move it to the header.',
		impact: 2,
		effort: 1,
		area: ['ui'],
		kind: 'task',
		needs: { 'ui-art': 2 }
	},
	roar: {
		title: 'Audio: boss roar cue for the slam wind-up',
		owner: 'rook',
		description: () =>
			'A low roar that lands on the first frame of the wind-up, loud enough to hear over the music. Needs two variants so it does not get stale.',
		brief: 'Boss roar sound cue that signals the slam wind-up.',
		impact: 3,
		effort: 2,
		area: ['boss', 'audio'],
		kind: 'task',
		needs: { audio: 3 }
	},
	embers: {
		title: 'Dragon death VFX: ember burst',
		owner: 'ivy',
		description: () =>
			'When the dragon dies it should come apart in embers, not just fade out. Particle budget is 2k.',
		brief: 'Ember burst effect for the dragon death.',
		impact: 3,
		effort: 3,
		area: ['boss', 'vfx'],
		kind: 'task',
		needs: { vfx: 4 }
	},
	menuAnim: {
		title: 'Menu transition animation polish',
		owner: 'ivy',
		description: () =>
			'The pause and settings menus pop in with no easing. Add a short slide and fade.',
		brief: 'Easing for the menu transitions.',
		impact: 2,
		effort: 2,
		area: ['ui', 'animation'],
		kind: 'task',
		needs: { animation: 2, 'ui-art': 2 }
	},
	oauth: {
		title: 'OAuth token refresh fails after the laptop sleeps',
		owner: 'rook',
		description: () =>
			'The launcher login keeps a stale refresh token after resume and bounces the player to the sign-in page.',
		brief: 'Launcher login loses its OAuth refresh token after the machine sleeps.',
		impact: 3,
		effort: 2,
		kind: 'task'
	},
	typo: {
		title: "Settings screen typo: 'Brightnes'",
		owner: 'rook',
		description: () => 'The brightness slider label is missing its last letter.',
		brief: 'Typo in the settings brightness label.',
		impact: 1,
		effort: 1,
		area: ['ui'],
		kind: 'task'
	},
	saveMigration: {
		title: 'Save migration crashes on v0.3 files',
		owner: 'rook',
		description: () =>
			'Loading a save from the v0.3 build throws in the migrator and the player loses their run.',
		brief: 'Save migrator crashes on files written by the v0.3 build.',
		impact: 5,
		effort: 3,
		kind: 'task',
		needs: { gameplay: 3 }
	},
	iFrames: {
		title: 'Lengthen the dodge i-frame window to 14 frames',
		owner: 'rook',
		closed: true,
		description: () => 'Roll i-frames go from 10 to 14 frames. Shipped in 0.4.',
		brief: 'Longer dodge i-frame window; shipped.',
		impact: 3,
		effort: 1,
		area: ['combat'],
		kind: 'task',
		needs: { gameplay: 3, combat: 3 },
		links: [{ type: 'relates', to: 'dodge' }]
	}
};

const COMMENTS: { on: LabourName; by: Owner; daysAgo: number; body: (k: Key) => string }[] = [
	{
		on: 'glow',
		by: 'rook',
		daysAgo: 6,
		body: () => '@ivy this is the first piece of the telegraph pass. Can you pick up the glow?'
	},
	{
		on: 'glow',
		by: 'rook',
		daysAgo: 2,
		body: () => '@ivy any early look? The warden fight needs it too.'
	},
	{
		on: 'anticipation',
		by: 'rook',
		daysAgo: 4,
		body: () => '@ivy the dragon slam is the worst offender, please start there.'
	},
	{
		on: 'menuAnim',
		by: 'rook',
		daysAgo: 12,
		body: () => 'Nice to have whenever @ivy has a gap.'
	},
	{
		on: 'telegraph',
		by: 'rook',
		daysAgo: 3,
		body: (k) =>
			`Breakdown: ${k('glow')} for the glow, ${k('anticipation')} for the pose, ${k('roar')} for the cue.`
	},
	{
		on: 'cantTell',
		by: 'rook',
		daysAgo: 1,
		body: (k) => `Same root cause as ${k('telegraph')}.`
	},
	{
		on: 'sponge',
		by: 'rook',
		daysAgo: 3,
		body: (k) => `${k('telegraph')} and ${k('damagePhases')} both address this.`
	},
	{
		on: 'dragon',
		by: 'ivy',
		daysAgo: 5,
		body: (k) =>
			`The wind-ups in ${k('telegraph')} would also make the second phase less of a slog.`
	},
	{
		on: 'hitStop',
		by: 'ivy',
		daysAgo: 8,
		body: (k) => `Works best once ${k('telegraph')} lands.`
	},
	{
		on: 'roar',
		by: 'ivy',
		daysAgo: 2,
		body: (k) => `Cue timing follows ${k('telegraph')}. @rook can you confirm the wind-up length?`
	},
	{
		on: 'hpRetune',
		by: 'ivy',
		daysAgo: 7,
		body: (k) => `Do this together with ${k('damagePhases')}.`
	}
];

type Key = (name: LabourName) => string;

const SKILLS = [
	[
		'vfx',
		'VFX',
		'1 can tweak a particle preset; 3 builds a readable effect; 5 owns the look of a fight.'
	],
	[
		'animation',
		'Animation',
		'1 can retime clips; 3 animates a readable attack; 5 owns the rig and the feel.'
	],
	['ui-art', 'UI art', '1 can nudge widgets; 3 lays out a screen; 5 owns the UI system.'],
	[
		'combat',
		'Combat',
		'1 can tune numbers; 3 builds attacks and hit detection; 5 owns the combat system.'
	],
	['gameplay', 'Gameplay', '1 can fix a bug; 3 builds a feature; 5 owns a game system.'],
	['audio', 'Audio', '1 can swap a sound; 3 builds a cue; 5 owns the mix.']
] as const;

export type Stormspire = {
	realmId: number;
	realmKey: 'SPIRE';
	users: { ivy: number; rook: number; forum: number };
	labours: Record<LabourName, { id: number; key: string }>;
	now: Date;
};

function agentUser(db: Db, username: string, displayName: string): number {
	return db
		.insert(users)
		.values({ kind: 'agent', username, displayName })
		.returning({ id: users.id })
		.get().id;
}

function humanUser(db: Db, username: string): number {
	return db
		.insert(users)
		.values({ kind: 'human', username, displayName: username, passwordHash: 'hash' })
		.returning({ id: users.id })
		.get().id;
}

function style(key: string, label: string, color: string, icon: string) {
	return { key, label, color, icon };
}

export function buildStormspire(db: Db): Stormspire {
	const ivy = humanUser(db, 'ivy');
	const rook = humanUser(db, 'rook');
	const forum = agentUser(db, 'forum', 'Forum feeder');
	const owners = { ivy, rook };
	const actor = { id: rook };

	const realm = createRealmWithStates(db, actor, {
		name: 'Stormspire',
		key: 'SPIRE',
		initialState: style('todo', 'To do', '#6b7280', 'circle'),
		states: [style('in-progress', 'In progress', '#2563eb', 'play')]
	});
	const closedState = listStates(db, realm.id).find((state) => state.isClosed)!;

	defineAttribute(db, actor, realm.id, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric:
			'1 is cosmetic; 3 is felt by some players; 5 changes how the game plays or blocks players.',
		spec: { min: 1, max: 5 }
	});
	defineAttribute(db, actor, realm.id, {
		key: 'effort',
		kind: 'scale',
		label: 'Effort',
		rubric: '1 is an afternoon; 3 is a week; 5 is a month or more.',
		spec: { min: 1, max: 5 }
	});
	defineAttribute(db, actor, realm.id, {
		key: 'area',
		kind: 'tags',
		label: 'Area',
		rubric: 'The part of the game the Labour is about.',
		spec: {
			members: ['boss', 'combat', 'ui', 'audio', 'vfx', 'animation'].map((key) => ({
				key,
				label: key
			}))
		}
	});
	defineAttribute(db, actor, realm.id, {
		key: 'kind',
		kind: 'tags',
		label: 'Kind',
		rubric: 'What sort of Labour it is: a player report, a design, or a task.',
		spec: {
			members: ['report', 'design', 'task'].map((key) => ({ key, label: key })),
			max: 1
		}
	});

	for (const [key, label, rubric] of SKILLS) defineSkill(db, actor, { key, label, rubric });
	setSkills(db, actor, ivy, { vfx: 4, animation: 3, 'ui-art': 2 });
	setSkills(db, actor, rook, { combat: 4, gameplay: 4, audio: 1 });

	const labours = {} as Stormspire['labours'];
	const keyOf: Key = (name) => `SPIRE-${NAMES.indexOf(name) + 1}`;

	const installed = !vi.isFakeTimers();
	const resume = Date.now();
	if (installed) vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(daysBefore(21));
		for (const name of NAMES) {
			const spec: Spec = LABOURS[name];
			const created = createLabour(db, actor, {
				realmId: realm.id,
				title: spec.title,
				description: spec.description(keyOf),
				ownerId: owners[spec.owner],
				stateId: spec.closed ? closedState.id : undefined
			});
			labours[name] = { id: created.id, key: created.key };
		}
		for (const { on, by, daysAgo, body } of [...COMMENTS].sort((a, b) => b.daysAgo - a.daysAgo)) {
			vi.setSystemTime(daysBefore(daysAgo));
			addComment(db, { id: owners[by] }, labours[on].id, body(keyOf));
		}
	} finally {
		if (installed) vi.useRealTimers();
		else vi.setSystemTime(resume);
	}

	const items: AppraiseItem[] = NAMES.map((name) => {
		const spec: Spec = LABOURS[name];
		return {
			labourId: labours[name].id,
			brief: spec.brief,
			values: {
				impact: spec.impact,
				effort: spec.effort,
				area: spec.area ?? null,
				kind: [spec.kind]
			},
			needs: spec.needs,
			links: spec.links?.map((link) => ({ type: link.type, to: labours[link.to].id })),
			stamp: readAppraisal(db, labours[name].id).contentHash
		};
	});
	appraise(db, { id: rook }, items, daysBefore(1));

	const pulses: [PulseInput, number][] = [
		[
			{
				key: 'area:boss',
				amount: 6,
				mood: -0.9,
				note: 'Bosses are bullet sponges, 40 upvotes',
				ref: 'forum-bullet-sponges',
				evidence: [
					{
						href: 'https://forum.stormspire.example/t/bosses-are-bullet-sponges',
						label: 'Forum thread'
					},
					{ labour: labours.sponge.id }
				]
			},
			1
		],
		[
			{
				key: 'area:boss',
				amount: 4,
				mood: -0.8,
				note: 'Dragon fight drags',
				ref: 'discord-dragon-drags',
				evidence: [{ labour: labours.dragon.id }]
			},
			3
		],
		[
			{
				key: 'area:boss',
				amount: 3,
				mood: -0.6,
				note: "Can't read the slam wind-up",
				ref: 'discord-slam-wind-up',
				evidence: [{ labour: labours.cantTell.id }]
			},
			4
		],
		[
			{
				key: 'area:ui',
				amount: 2,
				mood: -0.3,
				note: 'Stack counts hard to read on the Deck',
				ref: 'forum-stack-counts'
			},
			5
		],
		[
			{
				key: 'area:combat',
				amount: 4,
				mood: 0.8,
				note: 'Dodge feels great',
				ref: 'forum-dodge',
				evidence: [{ labour: labours.dodge.id }]
			},
			2
		]
	];
	for (const [pulse, daysAgo] of pulses) {
		postPulses(db, { id: forum }, realm.id, [pulse], daysBefore(daysAgo));
	}

	rebuildDerived(db, STORMSPIRE_NOW);

	return {
		realmId: realm.id,
		realmKey: 'SPIRE',
		users: { ivy, rook, forum },
		labours,
		now: STORMSPIRE_NOW
	};
}
