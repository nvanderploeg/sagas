import { visibleRealmIds } from '../../domain/access.ts';
import { z } from 'zod';
import { getRealm } from '../../domain/lookup.ts';
import {
	createRealm,
	deleteRealm,
	listRealms,
	renameRealmKey,
	setInitialState,
	updateRealm
} from '../../domain/realms.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	moveState,
	moveSubstate,
	setNextStates,
	setDefaultSubstate,
	updateState,
	updateSubstate
} from '../../domain/states.ts';
import { count, realmLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import {
	indexField,
	keyField,
	realmRef,
	stateRef,
	styleShape,
	substateRef,
	type Tools
} from '../tool.ts';

const DEFAULT_INITIAL_STATE = { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' };

const openField = z
	.boolean()
	.describe(
		'Whether Labours in this State count as open: ready to be worked or surveyed. States that still need grooming, like a backlog, are not.'
	);

const nextField = z
	.array(stateRef)
	.describe(
		'State keys a Labour in this State usually moves to next. A hint for choosing the next move; any Labour can still be moved to any State.'
	);

const styleUpdate = {
	label: styleShape.label.optional(),
	color: styleShape.color.optional(),
	icon: styleShape.icon.optional()
};

function realmReply(present: Presenter, realmId: number) {
	const realm = present.realm(realmId);
	return reply({ realm }, realmLine(realm));
}

export function registerRealmTools({ db, actor, define }: Tools): void {
	const inState = (args: { realm: string | number; state: string | number }) => {
		const realmId = refs.realmId(db, args.realm, actor);
		return { realmId, stateId: refs.stateId(db, realmId, args.state) };
	};
	const inSubstate = (args: {
		realm: string | number;
		state: string | number;
		substate: string | number;
	}) => {
		const { realmId, stateId } = inState(args);
		return { realmId, stateId, substateId: refs.substateId(db, stateId, args.substate) };
	};

	define(
		'list_realms',
		{
			kind: 'read',
			description: 'List every Realm with its key and name. get_realm shows its States.',
			input: {}
		},
		(_args, present) => {
			const visible = visibleRealmIds(db, actor);
			const realms = listRealms(db)
				.filter((p) => visible === null || visible.includes(p.id))
				.map((p) => {
					const { id, key, url, name, aliases } = present.realm(p.id);
					return { id, key, url, name, aliases };
				});
			const keys = realms.map((p) => p.key).join(', ');
			const summary =
				realms.length === 0 ? 'No Realms' : `${count(realms.length, 'Realm')}: ${keys}`;
			return reply({ realms }, summary);
		}
	);

	define(
		'get_realm',
		{
			kind: 'read',
			description:
				"Get a Realm with its States in board order, each with its Substates in order and default Substate, its Initial State, and its agent `notes`: how agents should work in this Realm. A Realm's States are its board columns; Closed is built in, always last, and cannot be renamed, reordered or removed.",
			input: { realm: realmRef }
		},
		(args, present) => realmReply(present, refs.realmId(db, args.realm, actor))
	);

	define(
		'create_realm',
		{
			kind: 'write',
			description:
				'Create a Realm with its Initial State and the built-in Closed State. The key is 2 to 6 letters or digits starting with a letter, unique across the instance, stored uppercase.',
			input: {
				name: z.string().describe('1 to 120 characters'),
				key: z.string().describe('Realm key, e.g. "AM"'),
				initialState: z
					.strictObject({ key: keyField, ...styleShape })
					.optional()
					.describe('The first State, where new Labours land; defaults to "todo" (To do)')
			}
		},
		(args, present) => {
			const realm = createRealm(db, actor, {
				name: args.name,
				key: args.key,
				initialState: args.initialState ?? DEFAULT_INITIAL_STATE
			});
			return realmReply(present, realm.id);
		}
	);

	define(
		'update_realm',
		{
			kind: 'write',
			description: 'Rename a Realm. Use rename_realm_key to change its key.',
			input: { realm: realmRef, name: z.string().describe('1 to 120 characters') }
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			updateRealm(db, actor, realmId, { name: args.name });
			return realmReply(present, realmId);
		}
	);

	define(
		'rename_realm_key',
		{
			kind: 'write',
			description:
				"Change a Realm's key. Every Labour gets a new key under it, and every old key stays an Alias that still resolves. The Realm can take a former key back.",
			input: { realm: realmRef, key: z.string().describe('The new Realm key') }
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			renameRealmKey(db, actor, realmId, args.key);
			return realmReply(present, realmId);
		}
	);

	define(
		'delete_realm',
		{
			kind: 'destroy',
			description:
				'Delete a Realm with all its States and Labours. Children in other Realms lose their Parent; deleted Labours leave their Quests.',
			input: { realm: realmRef }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const { key } = getRealm(db, realmId);
			deleteRealm(db, actor, realmId);
			return reply({ deleted: { id: realmId, key } }, `Deleted Realm ${key}`);
		}
	);

	define(
		'set_initial_state',
		{
			kind: 'write',
			description: "Set the State a Realm's new Labours land in. It cannot be Closed.",
			input: { realm: realmRef, state: stateRef }
		},
		(args, present) => {
			const { realmId, stateId } = inState(args);
			setInitialState(db, actor, realmId, stateId);
			return realmReply(present, realmId);
		}
	);

	define(
		'create_state',
		{
			kind: 'write',
			description:
				'Add a State (board column) to a Realm, before Closed: at `index` (0 is first) or last. It is open unless `open` is false; Surveys offer Labours in open States.',
			input: {
				realm: realmRef,
				key: keyField,
				...styleShape,
				index: indexField.optional().describe('0-based index among the States before Closed'),
				open: openField.optional().describe('Default true')
			}
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const { key, label, color, icon } = args;
			createState(db, actor, realmId, { key, label, color, icon }, args.index, args.open);
			return realmReply(present, realmId);
		}
	);

	define(
		'update_state',
		{
			kind: 'write',
			description:
				"Restyle a State (label, color, icon) and/or mark it open or not, and/or replace its next States (`next`, the usual moves from it). Its key never changes. Closed's label is fixed and it is never open.",
			input: {
				realm: realmRef,
				state: stateRef,
				...styleUpdate,
				open: openField.optional(),
				next: nextField.optional()
			}
		},
		(args, present) => {
			const { realmId, stateId } = inState(args);
			const next = args.next?.map((ref) => refs.stateId(db, realmId, ref));
			if (next) setNextStates(db, actor, stateId, next);
			updateState(db, actor, stateId, {
				label: args.label,
				color: args.color,
				icon: args.icon,
				open: args.open
			});
			return realmReply(present, realmId);
		}
	);

	define(
		'reorder_state',
		{
			kind: 'write',
			description:
				'Move a State to another column among the States before Closed. Closed always stays last.',
			input: {
				realm: realmRef,
				state: stateRef,
				index: indexField.describe('0-based index among the States before Closed')
			}
		},
		(args, present) => {
			const { realmId, stateId } = inState(args);
			moveState(db, actor, stateId, args.index);
			return realmReply(present, realmId);
		}
	);

	define(
		'delete_state',
		{
			kind: 'destroy',
			description:
				'Remove an empty State. Move its Labours out first; the Initial State and Closed cannot be removed.',
			input: { realm: realmRef, state: stateRef }
		},
		(args, present) => {
			const { realmId, stateId } = inState(args);
			deleteState(db, actor, stateId);
			return realmReply(present, realmId);
		}
	);

	define(
		'create_substate',
		{
			kind: 'write',
			description:
				"Add a Substate to a State, Closed included. A State's first Substate becomes its default, and every Labour already in the State moves into it: when a State has Substates, its Labours are always in one.",
			input: {
				realm: realmRef,
				state: stateRef,
				key: keyField,
				...styleShape,
				index: indexField.optional().describe('0-based index among the Substates; last by default')
			}
		},
		(args, present) => {
			const { realmId, stateId } = inState(args);
			const { key, label, color, icon } = args;
			createSubstate(db, actor, stateId, { key, label, color, icon }, args.index);
			return realmReply(present, realmId);
		}
	);

	define(
		'update_substate',
		{
			kind: 'write',
			description: 'Restyle a Substate: label, color or icon. Its key never changes.',
			input: { realm: realmRef, state: stateRef, substate: substateRef, ...styleUpdate }
		},
		(args, present) => {
			const { realmId, substateId } = inSubstate(args);
			updateSubstate(db, actor, substateId, {
				label: args.label,
				color: args.color,
				icon: args.icon
			});
			return realmReply(present, realmId);
		}
	);

	define(
		'reorder_substate',
		{
			kind: 'write',
			description: 'Move a Substate to another index within its State.',
			input: {
				realm: realmRef,
				state: stateRef,
				substate: substateRef,
				index: indexField.describe('0-based index among the Substates')
			}
		},
		(args, present) => {
			const { realmId, substateId } = inSubstate(args);
			moveSubstate(db, actor, substateId, args.index);
			return realmReply(present, realmId);
		}
	);

	define(
		'delete_substate',
		{
			kind: 'destroy',
			description:
				"Remove an empty Substate. Move its Labours out first. The default Substate can be removed only when it is the State's last one.",
			input: { realm: realmRef, state: stateRef, substate: substateRef }
		},
		(args, present) => {
			const { realmId, substateId } = inSubstate(args);
			deleteSubstate(db, actor, substateId);
			return realmReply(present, realmId);
		}
	);

	define(
		'set_default_substate',
		{
			kind: 'write',
			description: 'Set the Substate that Labours entering the State land in.',
			input: { realm: realmRef, state: stateRef, substate: substateRef }
		},
		(args, present) => {
			const { realmId, stateId, substateId } = inSubstate(args);
			setDefaultSubstate(db, actor, stateId, substateId);
			return realmReply(present, realmId);
		}
	);
}
