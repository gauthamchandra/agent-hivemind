# Where a message is recorded

## Status

Accepted on 17 November 2026.

## Context

A session can send one message to one member, or the planner can send one message to every other member. The message body can be more than one paragraph. The body is one fact. Each recipient's delivery is another fact: it has its own place in line, its own claim, and its own outcome. The task history is a third fact. It belongs to one task and must not become a second copy of the body.

A single mail-log row filtered by `task_id` cannot hold those apart. One message body can name several recipients, the sender may be a person with no task, and a delivery can be queued, claimed, delivered, or dropped without the body changing.

## Decision

The mail log (`messages`) stores the message body, with who said it and the kind. The body can be more than one paragraph. The cap stays 16 KiB. That row is written once, in the same transaction as the outbox rows, and the sender is answered before any platform call.

The outbox (`outbox_copies`) stores one recipient's delivery of that body. Its sequence is the order for that recipient. Its state is `queued`, `claimed`, `delivered`, or `dropped`. `delivered` means the platform accepted the text. It does not mean the recipient read it.

The task history stores one `message` event on the sender's task, or on the group's root task when the sender is a person. The event names the message, the kind, and the recipients. It does not contain the body. A drop stores one `message_dropped` event on the recipient's task, naming the message and the reason, and not the body.

A broadcast names every other member of the group. If any of them cannot receive, the request fails and neither table gains a row.

The sender's own limit is separate from the platform. The API returns `rate_limited` and stores nothing when the sender has sent 10 messages in a minute, 3 broadcasts in 10 minutes, or holds 5 open questions. The platform returns `busy` when that session is working and cannot take the text yet: the outbox row stays queued and is tried again. The platform returns `rate_limited` when the connection's call budget is spent: the same row stays queued, and `connection_send_pauses` records the time until the worker may call again. Each outbox row already has `next_attempt_at`; the pause is one clock for every copy on that connection, so one `rate_limited` response does not rewrite every queued row. `connection_rate_windows` is the rate-limit record for that budget: one row per connection per minute, counting message calls, stopping at 48.

A credential-shaped string is replaced in the body before the mail log stores it.

Example. The planner on "Calculate tax" asks the implementer "Which rounding mode?". The mail log gains one row with that body and kind `question`. The outbox gains one row for the implementer, sequence 1, state `queued`, then `delivered` when the platform accepts. The planner's task gains one `message` event with the message id and no body. If the platform says the implementer is busy, that outbox row stays `queued`. If the platform says the credential is rate limited, `connection_send_pauses` holds the next call and the same row waits. None of those outcomes rewrites the message body.

## Consequences

A reader of a task can see that a message was sent or dropped without opening the body. The mail view shows the newest 10,000 messages in a group. Deleting older rows waits for housekeeping. No backfill is required. The database starts empty of messages.
