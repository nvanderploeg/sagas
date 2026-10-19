# Webhooks

The contract for Webhooks: sagas POSTs Events to an outside service, so it gets changes without holding the Stream open. Events, their shape and their order are in `docs/events.md`; terms are in `CONTEXT.md`.

## Who

- Any User may create a Webhook and becomes its Owner.
- Only its Owner or an Admin sees or changes it. Anyone else gets `not_found`.
- Deleting a User deletes their Webhooks.
- Creating, changing or deleting a Webhook records no Events, as API tokens record none.
- A Webhook sends every Event that matches it, whoever made it. Every User can already read every Event on the Stream, so nothing is filtered by who is reading.

## Subscribing

| Field        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `name`       | 1–100 characters, for people.                                                     |
| `url`        | Where Deliveries go. See "Target URLs".                                           |
| `eventTypes` | Event types to send, from the table in `docs/events.md`. `null` sends every type. |
| `realmIds`   | Realms to send Events for. `null` sends every Event, whatever Realms it touches.  |
| `status`     | `active`, `paused` or `disabled`. See "Retries and disabling".                    |

- An Event matches when its type is in `eventTypes` and it touches a Realm in `realmIds`, each test passing when its list is `null`.
- A Webhook starts at the last seq assigned when it is created. It never sends Events from before then.
- Changing `eventTypes` or `realmIds` applies from the Webhook's cursor onward. Events already sent are not sent again.
- Deleting a Realm leaves its id in `realmIds`: it matches that Realm's `realm.deleted`, then nothing.

## Realms an Event touches

An Event does not list its Realms (`docs/events.md`). The log keeps them beside the Event, in `event_realms`, as it records it. They are pruned with their Event and never sent.

| Event                                          | Realms it touches                                                |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `realm.*`, `state.*`, `substate.*`             | That Realm.                                                      |
| `labour.moved`                                 | The Realm it left and the Realm it joined.                       |
| Any other `labour.*`, comments included        | The Labour's Realm when the Event is recorded.                   |
| `quest.labours_added`, `quest.labours_removed` | The Realms the named Labours were in when the Event is recorded. |
| Any other `quest.*`                            | None. Only a Webhook with `realmIds: null` gets it.              |

## Delivery

A Delivery is one POST carrying the next Events a Webhook has not yet received.

- **Cursor.** Each Webhook keeps the seq of the last Event it has dealt with. The log after the cursor is its outbox: nothing is queued anywhere else.
- **Order.** A Webhook has at most one Delivery in flight. The next waits until the last succeeds, so a receiver gets Events in seq order, with no gaps.
- **Batch.** A Delivery carries the Events after the cursor that match, in seq order: up to 100 Events or 256 KiB of body. An Event larger than that goes alone. Events that don't match move the cursor without a Delivery.
- **At least once.** The cursor moves only after a Delivery succeeds. A receiver can get the same Events again, after a timeout it answered too late, for example. Dedupe by `webhook-id` or by seq.
- **Success** is a 2xx answer within 10 seconds. Anything else fails, a redirect included: sagas never follows one. The response body is read up to 64 KiB, then dropped.
- **Off the request path.** A write never waits on a Delivery. A published Event wakes the dispatcher on a later turn, and a timer wakes it for retries. At most `WEBHOOK_CONCURRENCY` Webhooks deliver at once.

### Payload

`Content-Type: application/json`, one of:

```ts
// Events
{ webhook: { id: number; name: string }; events: Event[] }
// The Webhook fell past retention: see below
{ webhook: { id: number; name: string }; reset: { seq: number } }
// test_webhook
{ webhook: { id: number; name: string }; ping: true }
```

Each `Event` is the same object the Stream sends as `data`, `actor` included. An actor carries only `id`, `kind`, `username` and `displayName`.

### Falling past retention

The log keeps Events for `EVENT_RETENTION_DAYS`. When a Webhook's cursor falls before the oldest Event retained, its next Delivery is `reset`, with `seq` the last seq assigned, and the cursor jumps there. The receiver missed Events it can't get from sagas again: it reloads what it holds, as a Stream client does on `reset`.

## Retries and disabling

- A failed Delivery is retried with the same Events and the same `webhook-id`.
- The wait before retry `n` (from 0) is a random time between 0 and `min(1 h, 30 s × 2ⁿ)`.
- A Webhook failing without a success for `WEBHOOK_DISABLE_AFTER_HOURS` becomes `disabled` and stops. Its cursor stays where it was.
- `paused` is a person's choice; `disabled` is sagas'. Either way, nothing is sent until someone resumes it, which sets it `active` and retries at once. It carries on from its cursor, or with `reset` if that fell past retention.
- Keep `WEBHOOK_DISABLE_AFTER_HOURS` shorter than `EVENT_RETENTION_DAYS`, so a Webhook resumed soon after it disables has lost nothing.

## Signing

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/). Any of its libraries verifies them.

| Header              | Value                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-id`        | `<webhook id>:<first seq>-<last seq>`; `<webhook id>:reset-<seq>` or `<webhook id>:ping-<timestamp>` otherwise. The same on every retry. |
| `webhook-timestamp` | Unix seconds when this attempt was sent.                                                                                                 |
| `webhook-signature` | `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`, space-separated when two secrets sign.                                           |
| `user-agent`        | `sagas-webhooks`                                                                                                                         |

- A receiver rejects a timestamp more than 5 minutes from its own clock, as the standard says.
- A Webhook secret is `whsec_` and 32 random bytes in base64, the key being those bytes. It is shown once, when the Webhook is created or its secret rotated, and never again.
- Rotating makes a new secret. The old one signs alongside it for 24 hours, so a receiver can switch without dropping a Delivery.

## Secrets at rest

- A Webhook secret is stored encrypted with AES-256-GCM under `WEBHOOK_KEY`, 32 bytes in base64. Every other secret in sagas is a hash; this one must be read back to sign.
- Each stored secret records the fingerprint of the key that sealed it.
- Without `WEBHOOK_KEY`, every Webhook tool is `invalid`: `webhooks need WEBHOOK_KEY`, and nothing is delivered.
- When `WEBHOOK_KEY` changes, a Webhook whose secret was sealed under another key becomes `paused` with reason `key_changed`. Rotating its secret seals it under the new key; the receiver needs the new secret.

## Target URLs

Checked when a Webhook is created or its `url` changes, and again before every Delivery:

- `https` only, with no user or password in it.
- Its host resolves only to public addresses. Refused: loopback, private (RFC 1918), link-local, CGNAT (100.64/10), unique local (fc00::/7), multicast, unspecified, and IPv4-mapped forms of each.
- The Delivery connects to the address that passed the check, never to a second lookup, so a name can't switch to a private address in between.
- `WEBHOOK_ALLOW_PRIVATE=true` lifts both rules, for development and receivers on the same network.

A URL failing at create or update is `invalid`. A URL failing before a Delivery fails that Delivery.

## Delivery log

Each attempt is kept for `EVENT_RETENTION_DAYS`: when, the seq range or kind (`reset`, `ping`), the HTTP status or error, how long it took, and the first 512 bytes of the response body. `list_webhook_deliveries` reads it, newest first, and the Account page shows it.

## Limits and config

| Variable                      | Default | Meaning                                                                    |
| ----------------------------- | ------- | -------------------------------------------------------------------------- |
| `WEBHOOK_KEY`                 | unset   | 32 bytes in base64 that encrypt Webhook secrets. Unset turns Webhooks off. |
| `WEBHOOK_ALLOW_PRIVATE`       | `false` | Allow `http` and private addresses.                                        |
| `WEBHOOK_CONCURRENCY`         | 4       | Webhooks delivering at once.                                               |
| `WEBHOOK_DISABLE_AFTER_HOURS` | 72      | Failing this long disables a Webhook.                                      |
| `WEBHOOK_MAX_PER_USER`        | 10      | Webhooks one User may own.                                                 |
| `WEBHOOK_MAX`                 | 50      | Webhooks on the instance.                                                  |

Creating a Webhook past either cap is `conflict`.

## Tools

MCP tools, with the same actions on the Account page. `webhook` is an id; `user` defaults to `"me"`.

| Tool                      | Args                                                                                   | Result                                                      | Who            |
| ------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| `create_webhook`          | `name`, `url`, `eventTypes?`, `realms?`                                                | The Webhook, and its `secret`, shown once.                  | Any User       |
| `list_webhooks`           | `user?`                                                                                | The Webhooks, without secrets.                              | Owner or Admin |
| `update_webhook`          | `webhook`, `name?`, `url?`, `eventTypes?`, `realms?`, `status?` (`active` or `paused`) | The Webhook.                                                | Owner or Admin |
| `rotate_webhook_secret`   | `webhook`                                                                              | The new `secret`, shown once.                               | Owner or Admin |
| `test_webhook`            | `webhook`                                                                              | The attempt: status or error and duration. Moves no cursor. | Owner or Admin |
| `delete_webhook`          | `webhook`                                                                              | Nothing.                                                    | Owner or Admin |
| `list_webhook_deliveries` | `webhook`, page                                                                        | Attempts, newest first.                                     | Owner or Admin |
