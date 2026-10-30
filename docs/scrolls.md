# Scrolls

A Realm's wiki: Markdown pages in a tree. Vocabulary is in `CONTEXT.md`; access follows the `product/realm-access` Scroll; Events follow `docs/events.md`. Attachments are not part of this contract.

## Model

- A **Scroll** belongs to one Realm and has a title (1–120 characters), a slug, a Markdown body (at most 100,000 characters), an optional parent Scroll in the same Realm, and a rank among its siblings. It records who created it and who last changed it, and when.
- A **slug** is 1–64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit. Siblings never share a slug. A slug left out is made from the title: lowercased, accents dropped, every other run of characters turned into `-`, cut to 64; `page` when nothing is left.
- A Scroll's **path** is its ancestors' slugs and its own, joined by `/`: `ops/release-process`. A tree is at most 10 deep.
- Every path a Scroll has held, its current one included, stays in a lookup table pointing at the Scroll's id. A rename or move writes the new path of the Scroll and of every Scroll under it; old paths keep resolving to the same Scroll and redirect to its current path.
- A current path always wins. Creating, renaming or moving a Scroll onto a path that is only another Scroll's old path takes it over: the old path then points at the new holder.
- Sibling order is a fractional rank, as on a board. A new Scroll goes last among its siblings.
- A Scroll's **version** starts at 1 and rises by one with every change to its title, slug or body. A save names the version it was edited from; a save from an older version is refused with a conflict that names who changed it, and changes nothing.
- There is no revision history.

## Access

| Role   | May                                                                  |
| ------ | -------------------------------------------------------------------- |
| viewer | Read every Scroll in the Realm, search them, and follow their links. |
| editor | Also create, edit, rank, move and delete Scrolls.                    |

A Scroll in a Realm the caller cannot see is not found, worded as for one that does not exist.

## Body

- Markdown, rendered as Labour descriptions are: raw HTML is escaped, and an image renders as a link to it.
- `[[target]]` or `[[target|label]]` links to a Scroll in the same Realm. `target` is a path from the Realm's root; each segment is turned into a slug as a title is, so `[[Ops/Release process]]` names `ops/release-process`. It renders as a link to the Scroll's current path, showing the label or the Scroll's title. A target that resolves to no Scroll renders as a link to create it.
- `[[...]]` inside code is not a link.
- Labour keys and `@usernames` in the body are recorded as the Scroll's references, as Mentions are for Labours.

## Backlinks

A Scroll's **references** are what its body names: Scroll targets (kept as written, normalized), Labours and Users. They are rewritten on every body change and keep when each first appeared.

- A Scroll page lists the Scrolls whose references name any path the Scroll holds, current or old. A target written before its Scroll existed counts once the Scroll is created.
- A Labour page lists the Scrolls that reference it, in Realms the viewer can see.
- References are shown to people, unlike Mentions, which stay in the agent layer.

## Deleting

Deleting a Scroll with children takes one choice per direct child: **move** it (with everything under it) to the deleted Scroll's parent, or **delete** it with everything under it.

- Every direct child needs a choice, or the delete is refused and changes nothing.
- Moved children take the deleted Scroll's place among its siblings, in their own order.
- A moved child whose slug is already a sibling's there is refused, naming the clash; nothing changes.
- Deleting a Scroll removes its paths. Links to them render as links to create the page.
- Deleting a Realm deletes its Scrolls.

## Search

Full-text search over the titles and bodies of one Realm's Scrolls, best match first, a title match counting more than a body match.

## Events

ScrollView: `{ id, realmId, parentId, slug, path, title, body, rank, version, createdById, updatedById, createdAt, updatedAt }`.

| Type             | `data`                                                            | Recorded when                                                                                                                               |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `scroll.created` | `{ scroll }`                                                      | A Scroll is created.                                                                                                                        |
| `scroll.updated` | `{ scroll }`                                                      | Its title or body changes.                                                                                                                  |
| `scroll.moved`   | `{ scroll, paths: [{ id, previousPath, path }] }`                 | Its slug, parent or rank changes. `paths` lists every Scroll whose path changed, itself first; it is empty when only the rank changed.      |
| `scroll.deleted` | `{ realmId, ids, moved: [{ id, parentId, previousPath, path }] }` | A Scroll is deleted. `ids` lists every Scroll deleted; `moved` every Scroll whose path changed, the children moved up and those under them. |

A Scroll Event goes to members of its Realm. A write that changes title and slug together records `scroll.updated`, then `scroll.moved`.

A view of one Realm's Scrolls reloads on any `scroll.*` Event of that Realm. A Scroll page whose Scroll is in `ids` of `scroll.deleted` ends; one whose Scroll moved follows it to its new path.

## Web

| Page                | Shows                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/r/<key>/s`        | The tree, a search box (`?q=` lists matches), and for editors a new top-level Scroll form.                                          |
| `/r/<key>/s/<path>` | The tree, the Scroll's rendered body, its children and backlinks. Editors: edit, new child, move, drag to reorder siblings, delete. |

- An old path answers 308 to the current one. A path no Scroll holds is 404; for an editor it offers to create the Scroll there, under the longest leading path that exists, titled from the last segment.
- The Realm's board links to its Scrolls.

## MCP

`scroll` is a path string, which needs `realm`, or an id as a JSON number. An old path resolves as the current one.

| Tool             | Input                                                           | Output                                                                      |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list_scrolls`   | `realm`                                                         | `{ scrolls: [{ id, path, url, title, depth }] }`, depth first in rank order |
| `get_scroll`     | `realm?, scroll`                                                | `{ scroll: Scroll }`                                                        |
| `create_scroll`  | `realm, title, parent?, slug?, body?, placement`                | `{ scroll: Scroll }`                                                        |
| `update_scroll`  | `realm?, scroll, version?, title?, slug?, body?`                | `{ scroll: Scroll }`                                                        |
| `move_scroll`    | `realm?, scroll, parent?, placement`                            | `{ scroll: Scroll }`                                                        |
| `delete_scroll`  | `realm?, scroll, children?: "move" \| "delete", move?, delete?` | `{ deleted: [path], moved: [{ from, to }] }`                                |
| `search_scrolls` | `realm, query, limit? (20)`                                     | `{ scrolls: [{ id, path, url, title, snippet }] }`                          |

- Scroll: `{ id, realm, path, url, title, body, version, parent, children: [{ path, title }], backlinks: [{ path, title }], labours: [key], createdBy, updatedBy, createdAt, updatedAt }`.
- `placement` is `position` (`top` or `bottom`), `before` or `after` a sibling Scroll. `parent: null` moves a Scroll to the top level; leaving `parent` out keeps it.
- `update_scroll` checks `version` when given. Leaving it out saves over whatever is there.
- `delete_scroll`: `move` and `delete` list direct children; `children` is the choice for every child not listed. A child listed in both, or a Scroll that is not a direct child, fails the call.
