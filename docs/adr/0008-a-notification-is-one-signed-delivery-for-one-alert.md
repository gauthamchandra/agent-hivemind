# A notification is one signed delivery for one alert

## Status

Accepted on 19 November 2026. The code lands with this decision. It adds to [ADR 0007](0007-a-job-lock-keeps-each-background-job-to-one-process.md) and changes nothing that ADR decided: an alert still notifies once, reminds with a new delivery id, and goes to one signed webhook. The address rule below is stricter than the one in ADR 0007, and every address that ADR refuses is still refused.

## Context

An alert is a row. Until it is sent somewhere, nobody is told that it opened, and a person has to look at the alerts to learn that a session died or asked for help. ADR 0007 decides that the usage poll opens and clears alerts under a job lock, and that a notification goes to one signed webhook. It does not say what stops a receiver that was down from getting every old alert at once, what happens when a condition clears and returns, how a failed delivery is sent again, or what makes an address safe to call.

Three facts shape the answer. The receiver is often a Slack Workflow webhook, and its trigger takes only flat key-value pairs. The address of a Slack workflow is a secret, so no log line or error message may repeat it. And an operator types the address, so the service must not become a way to reach a private network.

## Decision

An alert is notified at most once per reminder interval, even if it clears and returns. A new alert row for the same rule and target inherits when the earlier rows were last notified, as long as that was less than one interval ago, so a new incident soon after a notified one waits out the rest of the interval. The interval is 4 hours for a critical alert and 24 hours for the rest. After the interval the alert is sent again as a reminder, with a new delivery id. Reminders stop 7 days after the alert opened.

A notification is one delivery for one alert. The usage poll sends the notifications at the end of its run, under its lock id, and records each delivery in `alert_deliveries` before it sends anything. An alert has at most one outstanding delivery, and the database enforces that. A delivery that failed, or that stays in `sending`, is sent again under the same delivery id after 5 minutes, then after twice as long following each send, up to an hour, so a delivery that keeps failing does not take the slots of newer alerts. With no webhook configured, nothing is delivered and nothing is recorded.

A delivery is not sent again once it is a day old, once its alert has closed, or once its alert is too old for it: a first notification is sent only within a day of the alert opening, and a reminder only within a week. An alert that was not notified within a day of opening is never first notified, so a receiver that was down does not get a backlog all at once. A run sends at most five deliveries, critical first and then the alert open longest, and the rest wait for the next run. The sends of a run go out together, and each is cut off after 10 seconds, from the name lookup to the headers of the response.

The body is one flat object of string values. It carries names and titles and, for an escalation, the reason. The reason is free text that the session wrote. It is redacted only for this service's own token formats, so the webhook is an internal channel and a person should treat it as one.

The address must be https. http is accepted only when the host is loopback, and not while `HTTP_PROXY` applies to it, because Bun would send that request through the proxy in the clear. Every other address is refused when it is not on the public internet: private, loopback, link-local, multicast or reserved, including an IPv4 address written inside an IPv6 address. An address that can never be safe stops the service at startup, without a lookup and without repeating the address in the message. The notifier resolves the name once, and every address in the answer must parse strictly as a public address, so a zone id or a short number is refused. It tries the checked addresses in turn, IPv4 first, inside its one time limit, connects to the address, and verifies the server's certificate against the host name in the address, not against the address it connected to. It does not follow a redirect. A failed lookup or request names only an error code, never the address, the host, or the body.

For example, a critical alert for a dead session opens at 10:00 and is notified at 10:01. It clears at 11:00 and returns at 12:00. The new row inherits 10:01, which is less than 4 hours ago, so it is not notified at once. It is notified again, with a new delivery id, at the first run after 14:01.

## Consequences

A notification can arrive twice. A delivery that the receiver accepted but the service did not record, after a lost reply or a reset once the body went out, is sent again under the same delivery id. A receiver that must not show a repeat discards a delivery id it has already seen.

A changed escalation reason is sent with the next reminder, not at once. The names in a notification are empty for a settled session and for a wait or connection alert, and `target_id` says what the alert concerns. The first retry of a failed delivery can wait two runs instead of one.

On https the Host header carries the host name without the port, because Bun checks the certificate against the Host header and the port would make every name fail. A receiver on a port that is not the default sees no port in that header.

Nothing acknowledges an alert yet, and deliveries are not pruned until housekeeping lands.
