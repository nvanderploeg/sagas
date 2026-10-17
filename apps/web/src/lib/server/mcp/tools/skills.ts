import { z } from 'zod';
import { defineSkill, listSkills, setSkills } from '../../agent/skills.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { keyField, userRef, type Tools } from '../tool.ts';

const levelsShape = z
	.record(z.string(), z.number().int().nullable())
	.describe('Skill key to a level from 1 to 5; null clears');

export function registerSkillTools({ db, actor, define }: Tools): void {
	define(
		'define_skill',
		{
			kind: 'write',
			description:
				'Name a Skill for the whole instance, or revise it when the key exists. Users hold Skills at levels 1 to 5 (set_skills) and Labours need them at levels (appraise); the rubric says what each level means.',
			input: {
				key: keyField,
				label: z.string().optional().describe('1 to 64 characters; required to create'),
				rubric: z
					.string()
					.optional()
					.describe('Markdown on what the levels 1 to 5 mean, up to 4,000 characters; "" clears')
			}
		},
		(args) => {
			const { key, label, rubric } = defineSkill(db, actor, args);
			return reply({ skill: { key, label, rubric } }, `Skill ${key}: ${label}`);
		}
	);

	define(
		'list_skills',
		{
			kind: 'read',
			description: 'List every Skill by key, with how many Users hold it.',
			input: {}
		},
		() => {
			const skills = listSkills(db).map(({ key, label, rubric, holders }) => ({
				key,
				label,
				rubric,
				holders
			}));
			return reply(
				{ skills },
				`${count(skills.length, 'Skill')}: ${skills.map((skill) => skill.key).join(', ')}`
			);
		}
	);

	define(
		'set_skills',
		{
			kind: 'write',
			description:
				"Set the levels a User holds in Skills, 1 to 5, or clear them with null; Skills you leave out stay. Any User may set any User's Skills. All or nothing. Returns the User's whole set.",
			input: { user: userRef, skills: levelsShape }
		},
		(args, present) => {
			const userId = refs.userId(db, args.user, actor);
			const held = setSkills(db, actor, userId, args.skills);
			const user = present.username(userId);
			return reply(
				{ user, skills: held },
				`${user} holds ${count(Object.keys(held).length, 'Skill')}`
			);
		}
	);
}
