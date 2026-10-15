import { z } from 'zod';
import { getProject } from '../../domain/lookup.ts';
import {
	createProject,
	deleteProject,
	listProjects,
	renameProjectKey,
	setInitialState,
	updateProject
} from '../../domain/projects.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	updateState,
	updateSubstate
} from '../../domain/states.ts';
import { count, projectLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import {
	indexField,
	keyField,
	projectRef,
	stateRef,
	styleShape,
	substateRef,
	type Tools
} from '../tool.ts';

const DEFAULT_INITIAL_STATE = { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' };

const styleUpdate = {
	label: styleShape.label.optional(),
	color: styleShape.color.optional(),
	icon: styleShape.icon.optional()
};

function projectReply(present: Presenter, projectId: number) {
	const project = present.project(projectId);
	return reply({ project }, projectLine(project));
}

export function registerProjectTools({ db, actor, define }: Tools): void {
	const inState = (args: { project: string | number; state: string | number }) => {
		const projectId = refs.projectId(db, args.project);
		return { projectId, stateId: refs.stateId(db, projectId, args.state) };
	};
	const inSubstate = (args: {
		project: string | number;
		state: string | number;
		substate: string | number;
	}) => {
		const { projectId, stateId } = inState(args);
		return { projectId, stateId, substateId: refs.substateId(db, stateId, args.substate) };
	};

	define(
		'list_projects',
		{
			kind: 'read',
			description: 'List every Project with its key and name. get_project shows its States.',
			input: {}
		},
		(_args, present) => {
			const projects = listProjects(db).map((p) => {
				const { id, key, name, aliases } = present.project(p.id);
				return { id, key, name, aliases };
			});
			const keys = projects.map((p) => p.key).join(', ');
			const summary =
				projects.length === 0 ? 'No Projects' : `${count(projects.length, 'Project')}: ${keys}`;
			return reply({ projects }, summary);
		}
	);

	define(
		'get_project',
		{
			kind: 'read',
			description:
				"Get a Project with its States in board order, each with its Substates in order and default Substate, and its Initial State. A Project's States are its board columns; Closed is built in, always last, and cannot be renamed, reordered or removed.",
			input: { project: projectRef }
		},
		(args, present) => projectReply(present, refs.projectId(db, args.project))
	);

	define(
		'create_project',
		{
			kind: 'write',
			description:
				'Create a Project with its Initial State and the built-in Closed State. The key is 2 to 6 letters or digits starting with a letter, unique across the instance, stored uppercase.',
			input: {
				name: z.string().describe('1 to 120 characters'),
				key: z.string().describe('Project key, e.g. "AM"'),
				initialState: z
					.strictObject({ key: keyField, ...styleShape })
					.optional()
					.describe('The first State, where new Tickets land; defaults to "todo" (To do)')
			}
		},
		(args, present) => {
			const project = createProject(db, actor, {
				name: args.name,
				key: args.key,
				initialState: args.initialState ?? DEFAULT_INITIAL_STATE
			});
			return projectReply(present, project.id);
		}
	);

	define(
		'update_project',
		{
			kind: 'write',
			description: 'Rename a Project. Use rename_project_key to change its key.',
			input: { project: projectRef, name: z.string().describe('1 to 120 characters') }
		},
		(args, present) => {
			const projectId = refs.projectId(db, args.project);
			updateProject(db, actor, projectId, { name: args.name });
			return projectReply(present, projectId);
		}
	);

	define(
		'rename_project_key',
		{
			kind: 'write',
			description:
				"Change a Project's key. Every Ticket gets a new key under it, and every old key stays an Alias that still resolves. The Project can take a former key back.",
			input: { project: projectRef, key: z.string().describe('The new Project key') }
		},
		(args, present) => {
			const projectId = refs.projectId(db, args.project);
			renameProjectKey(db, actor, projectId, args.key);
			return projectReply(present, projectId);
		}
	);

	define(
		'delete_project',
		{
			kind: 'destroy',
			description:
				'Delete a Project with all its States and Tickets. Children in other Projects lose their Parent; deleted Tickets leave their Quests.',
			input: { project: projectRef }
		},
		(args) => {
			const projectId = refs.projectId(db, args.project);
			const { key } = getProject(db, projectId);
			deleteProject(db, actor, projectId);
			return reply({ deleted: { id: projectId, key } }, `Deleted Project ${key}`);
		}
	);

	define(
		'set_initial_state',
		{
			kind: 'write',
			description: "Set the State a Project's new Tickets land in. It cannot be Closed.",
			input: { project: projectRef, state: stateRef }
		},
		(args, present) => {
			const { projectId, stateId } = inState(args);
			setInitialState(db, actor, projectId, stateId);
			return projectReply(present, projectId);
		}
	);

	define(
		'create_state',
		{
			kind: 'write',
			description:
				'Add a State (board column) to a Project. It goes among the open States, before Closed: at `index` (0 is first) or last.',
			input: {
				project: projectRef,
				key: keyField,
				...styleShape,
				index: indexField.optional().describe('0-based index among the open States')
			}
		},
		(args, present) => {
			const projectId = refs.projectId(db, args.project);
			const { key, label, color, icon } = args;
			createState(db, actor, projectId, { key, label, color, icon }, args.index);
			return projectReply(present, projectId);
		}
	);

	define(
		'update_state',
		{
			kind: 'write',
			description:
				"Restyle a State: label, color or icon. Its key never changes. Closed's label is fixed.",
			input: { project: projectRef, state: stateRef, ...styleUpdate }
		},
		(args, present) => {
			const { projectId, stateId } = inState(args);
			updateState(db, actor, stateId, { label: args.label, color: args.color, icon: args.icon });
			return projectReply(present, projectId);
		}
	);

	define(
		'reorder_state',
		{
			kind: 'write',
			description:
				'Move a State to another column among the open States. Closed always stays last.',
			input: {
				project: projectRef,
				state: stateRef,
				index: indexField.describe('0-based index among the open States')
			}
		},
		(args, present) => {
			const { projectId, stateId } = inState(args);
			moveState(db, actor, stateId, args.index);
			return projectReply(present, projectId);
		}
	);

	define(
		'delete_state',
		{
			kind: 'destroy',
			description:
				'Remove an empty State. Move its Tickets out first; the Initial State and Closed cannot be removed.',
			input: { project: projectRef, state: stateRef }
		},
		(args, present) => {
			const { projectId, stateId } = inState(args);
			deleteState(db, actor, stateId);
			return projectReply(present, projectId);
		}
	);

	define(
		'create_substate',
		{
			kind: 'write',
			description:
				"Add a Substate to a State, Closed included. A State's first Substate becomes its default, and every Ticket already in the State moves into it: when a State has Substates, its Tickets are always in one.",
			input: {
				project: projectRef,
				state: stateRef,
				key: keyField,
				...styleShape,
				index: indexField.optional().describe('0-based index among the Substates; last by default')
			}
		},
		(args, present) => {
			const { projectId, stateId } = inState(args);
			const { key, label, color, icon } = args;
			createSubstate(db, actor, stateId, { key, label, color, icon }, args.index);
			return projectReply(present, projectId);
		}
	);

	define(
		'update_substate',
		{
			kind: 'write',
			description: 'Restyle a Substate: label, color or icon. Its key never changes.',
			input: { project: projectRef, state: stateRef, substate: substateRef, ...styleUpdate }
		},
		(args, present) => {
			const { projectId, substateId } = inSubstate(args);
			updateSubstate(db, actor, substateId, {
				label: args.label,
				color: args.color,
				icon: args.icon
			});
			return projectReply(present, projectId);
		}
	);

	define(
		'reorder_substate',
		{
			kind: 'write',
			description: 'Move a Substate to another index within its State.',
			input: {
				project: projectRef,
				state: stateRef,
				substate: substateRef,
				index: indexField.describe('0-based index among the Substates')
			}
		},
		(args, present) => {
			const { projectId, substateId } = inSubstate(args);
			moveSubstate(db, actor, substateId, args.index);
			return projectReply(present, projectId);
		}
	);

	define(
		'delete_substate',
		{
			kind: 'destroy',
			description:
				"Remove an empty Substate. Move its Tickets out first. The default Substate can be removed only when it is the State's last one.",
			input: { project: projectRef, state: stateRef, substate: substateRef }
		},
		(args, present) => {
			const { projectId, substateId } = inSubstate(args);
			deleteSubstate(db, actor, substateId);
			return projectReply(present, projectId);
		}
	);

	define(
		'set_default_substate',
		{
			kind: 'write',
			description: 'Set the Substate that Tickets entering the State land in.',
			input: { project: projectRef, state: stateRef, substate: substateRef }
		},
		(args, present) => {
			const { projectId, stateId, substateId } = inSubstate(args);
			setDefaultSubstate(db, actor, stateId, substateId);
			return projectReply(present, projectId);
		}
	);
}
