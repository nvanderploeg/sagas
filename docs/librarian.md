# Librarian

The Agent user that keeps the agent layer true to the board, and feeds each Realm's Sentiment from its own tickets. Vocabulary is in `CONTEXT.md`; the data it works on is in `docs/agent-layer.md`. The Agent layer Quest builds every tool the librarian uses, but not the librarian.

## Who it is

- An Agent user named `librarian`, with its own API token. There is one per instance, and it works one Realm at a time.
- It runs as a skill. Each pass is one headless agent session, started on a schedule or on request ("catch up SPIRE").
- It writes only to the agent layer. It never changes a Labour's title, description, Labels, State, Owner or Assignee, and it never comments. People see its work only in the Advanced view.

## A pass

One pass covers one Realm. It works through these steps in order until its budget runs out:

1. **Ground.** Call `get_attributes` and `get_sentiment`, and read the Realm's notes first. They say who feeds the Realm, how it marks reports, and how to judge its Attributes.
2. **Appraise.** Work through `list_unappraised`: unappraised Labours newest first, then stale content, then values set before a revision. For each one, take its `content_hash`, read the Labour and its Comments, then `appraise` in batches:
   - **Brief:** say what the Labour is about, in the words the Realm's Attributes and members use.
   - **References:** the ones its text names.
   - **Values:** set every Attribute its rubric lets the librarian judge. One it can't judge stays unset and counts as neutral; never guess.
   - **Skills:** the Skills it needs.
   - **Links:** `duplicates` and `blocks` where the text says so. Add `evidence` from a report to the designs and tasks it backs, found by a Survey on the report's Brief that weights `similarity` and `keywords`.
3. **Feed Sentiment from tickets.** For each report appraised in this pass, post one Pulse per key it touches:
   - **Amount:** from how many players the report speaks for, and how badly.
   - **Mood:** from its tone.
   - **Evidence:** the report itself.
   - **`ref`:** the report's Labour id, so a report counts once however often it is read.
4. **File unfiled Pulses.** File each unfiled raw key under an existing key that means the same. If a theme keeps coming back (several Pulses, or real volume, within a week) and nothing fits, add a member or an Attribute within the caps, then file it. Otherwise leave it unfiled.
5. **Tend the list.** Merge members that mean the same: file the Pulses of one under the other and rewrite its values. Remove members that no Labour has held and no Pulse has named for 90 days.

## Rules

- **Calibrate.** Before scoring an Attribute, look at how its values are spread across Labours and score in line with that.
- **Stamp honestly.** Take a Labour's `content_hash` from `get_appraisal` before reading it, read it whole, and pass that hash as `stamp`. A Labour that changed meanwhile stays unstamped and comes back next pass.
- **Don't race people.** Skip a Labour that a person changed in the last 10 minutes; the next pass picks it up.
- **Leave Affinity alone.** It comes from Outcomes.
- **Stay in budget.** A pass stops after a set number of Labours or minutes. Whatever is left waits for the next pass.

## What the build gives it

| Need                    | Tool                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| What changed            | `list_unappraised`, with the reason each Labour is listed          |
| How to judge            | `get_attributes`: notes, rubrics, and how often each value is used |
| Writing the layer       | `appraise` in batches, `define_attribute`, `tune_realm`            |
| Finding related Labours | `survey`                                                           |
| Feeding Sentiment       | `pulse`, with `ref`                                                |
| Filing                  | `get_sentiment` for unfiled keys, `file_pulses`, `delete_pulse`    |

## Open

- Where it runs: a scheduled cloud routine, or a loop beside the local helper.
- Which model, and whether tending the list gets a stronger one than appraising.
- When it wakes: on a timer, or on change. The Stream already carries every Labour change to any token holder.
- Whether people can ask it for a digest, such as how a Realm's Sentiment moved this week.
