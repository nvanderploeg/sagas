import { visibleRealmIds } from '../../domain/access.ts';
import { queryLabours } from '../../domain/labour-query.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { realmRef, type Tools } from '../tool.ts';
import { BOARD_URI } from '../ui/resources.ts';

const BOARD_LIMIT = 200;

export function registerBoardTools({ db, actor, define }: Tools): void {
	define(
		'show_board',
		{
			kind: 'read',
			description: `Show a Realm's board: its States as columns with each unfinished Labour as a card, and Closed Labours counted. Opens an interactive view where the host supports one. Lists at most ${BOARD_LIMIT} Labours; use list_labours for more.`,
			input: { realm: realmRef },
			meta: { ui: { resourceUri: BOARD_URI } }
		},
		async (args, present) => {
			const realmId = await refs.realmId(db, args.realm, actor);
			const realm = await present.realm(realmId);
			const page = await queryLabours(
				db,
				{ realms: (await visibleRealmIds(db, actor)) ?? undefined, realmId },
				{ offset: 0, limit: BOARD_LIMIT }
			);
			const labours = await present.labours(page.labours);
			return reply(
				{
					realm: {
						key: realm.key,
						name: realm.name,
						url: realm.url,
						states: realm.states.map(({ key, label, color, closed, open }) => ({
							key,
							label,
							color,
							closed,
							open
						}))
					},
					labours: labours.map((l) => ({
						key: l.key,
						url: l.url,
						title: l.title,
						brief: l.brief,
						state: l.state.key,
						substate: l.substate?.label ?? null,
						assignee: l.assignee,
						labels: l.labels
					})),
					total: page.total,
					truncated: page.total > labours.length
				},
				`${realm.name} board: ${page.total} Labours across ${realm.states.length} States`
			);
		}
	);
}
