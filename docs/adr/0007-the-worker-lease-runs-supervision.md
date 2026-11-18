# The worker lease runs supervision

## Status

Accepted on 17 November 2026.

## Context

A session reports its own work, and that report is trusted because the caller holds the session token. The report does not say what the platform is doing, or what the session has spent. Spend is what stops the next start once a group reaches its budget. If the service learns the spend only when a session ends, a group can pass its budget by whatever the still-running sessions consume.

Several `hivemind-svc` processes can be up at once. They share one PostgreSQL database. A timer that lives only in the memory of one process cannot tell the others that the tick already ran. A second way to start the same tick, such as an HTTP route called by an external scheduler, would be a second owner of the same work.

The platform call that reads status or usage, and the call that suspends or ends a session, cannot carry a database lock. A process can lose the right to write after it has already started one of those calls.

## Decision

The process that drains the outbox also runs three jobs from its timer: the fleet check every 5 minutes, the reaper every 15 minutes, and housekeeping every 24 hours. Before a job runs, the process takes a row in `leases`. The row holds the holder, an expiry 4 minutes out, and an epoch. Taking the row is one conditional update, and that statement is the same on PGlite and on PostgreSQL. The process that does not get the row does not run the tick.

Every write the tick makes is in a transaction that locks that lease row for the epoch it took. While the epoch still matches, the write extends the expiry, so a run can outlast the original four minutes. If the epoch no longer matches, the transaction writes nothing. The caller learns that the epoch is stale. A holder that stops, and makes no further write, blocks the job until the expiry.

A call to a platform or a notifier is made only after the tick has committed an intent: the action, the target, and a stable identifier. The intent write is the last moment the tick can show that it still holds the lease. The call that follows is one that is safe to repeat. The next process that takes the lease finishes an open intent. It does not write a second intent for the same action.

The fleet check stores each session's neutral status and its cumulative usage, and adds only the increase to that session's group. A group has one connection, and the connection has one usage unit. A reading from another connection is never added to the group's spend. A reading taken while a session is still running does not clear the flag that says a final reading is still owed after the session ends. A missing reading does not clear it either. Zero is a reading, so it does. That flag is only the reading. `platform_stop_pending` means the platform end has not succeeded. A reading, including zero, does not clear it. The reaper and the end path clear it only after the platform stop succeeds, so a poll cannot leave a platform session running.

A finding has a stable key, the rule name plus the target. The same condition notifies once, sends a reminder after its reminder interval with a new delivery id, and clears when it ends. A dead session, two readings of stopped, failed, or unknown on an open task, opens one finding. The reaper ends sessions of a task that has been closed for 60 minutes, resolves a `starting` row older than 10 minutes, and resumes an end that stopped halfway. It does not start a session. There is no HTTP route that runs any of the three jobs.

The webhook notifier sends one signed POST. The address must be https. http is accepted only when the host is loopback. Every other address is refused when it is private, loopback, or link-local. The notifier resolves the name once, connects to that address, sends the original host name, and does not follow a redirect.

For example, a group whose sessions read 1.5 and 2.5 in that connection's unit stores those two numbers and sets the group's spend to 4. A second group whose session reads 1000 in a different unit stays at 1000. The tick does not store 1004.

## Consequences

A holder that stops blocks its job until the 4-minute lease expires. The next tick, on a worker that takes the lease, continues from the intents that were committed.

A start can still be accepted between ticks. The budget refuses the next start once a tick has recorded that spend reached it. The budget does not end sessions that are already running.

The console inbox is the finding row. A webhook is optional. A receiver that must not show a repeat discards a delivery id it has already seen.

A closed group is removed 90 days after it closed, and only when no session is still starting, live, or released, and none still owes a final reading or a platform stop. Deleting its task history is allowed only inside that retention transaction. Every other delete of a task event is still rejected.
