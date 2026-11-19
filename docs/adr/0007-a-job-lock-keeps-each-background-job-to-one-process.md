# A job lock keeps each background job to one process

## Status

Accepted on 17 November 2026. The decision is accepted whole and the code lands in stages. The job lock, the reaper and the usage poll are built. Alerts, notifications and housekeeping are not.

## Context

A session reports its own work, and that report is trusted because the caller holds the session token. The report does not say what the platform is doing, or what the session has spent. Spend is what stops the next start once a group reaches its budget. If the service learns the spend only when a session ends, a group can pass its budget by whatever the still-running sessions consume.

Several `hivemind-svc` processes can be up at once. They share one PostgreSQL database. A timer that lives only in the memory of one process cannot tell the others that a job already ran. A second way to start the same job, such as an HTTP route called by an external scheduler, would be a second owner of the same work.

The platform call that reads status or usage, and the call that suspends or ends a session, cannot carry a database lock. A process can lose the right to write after it has already started one of those calls.

## Decision

The process that drains the outbox also runs three background jobs from its timer: the usage poll every 5 minutes, the reaper every 15 minutes, and housekeeping every 24 hours. Before a job runs, the process takes the job's row in `job_locks`. The row holds the worker that locked it, an expiry 4 minutes out, and a lock id. The lock id is a number that goes up by one each time a worker takes the lock. Taking the row is one conditional update, and that statement is the same on PGlite and on PostgreSQL. The process that does not get the row does not run the job.

Every write a job run makes to its own records is in a transaction that locks that row for the lock id the run took. Those records are the session job state, the planned actions, and the counter repairs. While the lock id still matches, the write extends the expiry, so a run can outlast the original four minutes. If the lock id no longer matches, the transaction writes nothing. The caller learns that its lock id is old. A worker that stops, and makes no further write, blocks the job until the expiry.

The lock id does not cover an operation that any caller may run, such as ending a session. That operation keeps its own locks and is safe to repeat. A worker that lost the job lock and finishes such an operation late does no harm, because the next worker would have made the same call. For example, the reaper ends a session whose task has been closed for 60 minutes. A closed task does not reopen, so the end is still due when a worker that lost the lock completes it.

A call to a platform or a notifier is made only after the run has recorded a planned action: the action, the target, and a stable identifier. Recording it is the last moment the run can show that it still holds the job lock. The call that follows is one that is safe to repeat. The next worker that takes the lock finishes an open planned action. It does not record a second one for the same action.

The usage poll stores each session's neutral status and its cumulative usage, and adds only the increase to that session's group. A group has one connection, and the connection has one usage unit. A reading from another connection is never added to the group's spend. A reading taken while a session is still running does not clear the flag that says a final reading is still owed after the session ends. A missing reading does not clear it either. Zero is a reading, so it does. The poll leaves the flag alone while a platform stop is owed. Once none is, an ended session, or a failed start that was given a platform session, that the platform no longer knows owes a reading that can never arrive, so the poll clears the flag without a reading and leaves its usage and last reading time as they were. That flag is only the reading. `platform_stop_pending` means the platform end has not succeeded. A reading, including zero, does not clear it. The reaper and the end path clear it only after the platform stop succeeds, so a poll cannot leave a platform session running.

An alert has a stable key, the rule name plus the target. The same condition notifies once, sends a reminder after its reminder interval with a new delivery id, and clears when it ends. A dead session, two readings of stopped, failed, or unknown on an open task, opens one alert. The reaper ends sessions of a task that has been closed for 60 minutes, resolves a `starting` row older than 10 minutes, and resumes an end that stopped halfway. It does not start a session. There is no HTTP route that runs any of the three jobs.

The webhook notifier sends one signed POST. The address must be https. http is accepted only when the host is loopback. Every other address is refused when it is private, loopback, or link-local. The notifier resolves the name once, connects to that address, sends the original host name, and does not follow a redirect.

For example, a group whose sessions read 1.5 and 2.5 in that connection's unit stores those two numbers and sets the group's spend to 4. A second group whose session reads 1000 in a different unit stays at 1000. The usage poll does not store 1004.

## Consequences

A worker that stops blocks its job until the 4-minute job lock expires. The next run, on a worker that takes the lock, continues from the planned actions that were recorded.

A worker that lost the lock can still finish a session end that it had already started. The session ends a little late, which is what the next worker would have done. A planned action whose target has already settled stays open until its group is removed. The one exception is the usage poll, which finishes its own `poll` action once the session leaves the snapshot, because a poll only reads. It is a record of what was started, and a later attempt at the same action on that target reuses it.

The service puts no timeout around a platform call: an adapter bounds every call it makes. A call that never returns holds the run that made it, and the process starts no new run while one is in flight, so neither job runs again in that process until the call returns. The poll's four-minute deadline is checked between sessions, not during a read.

A start can still be accepted between runs. The budget refuses the next start once a run has recorded that spend reached it. The budget does not end sessions that are already running.

The console inbox is the alert row. A webhook is optional. A receiver that must not show a repeat discards a delivery id it has already seen.

A closed group is removed 90 days after it closed, and only when no session is still starting, live, or released, and none still owes a final reading or a platform stop. Deleting its task history is allowed only inside that retention transaction. Every other delete of a task event is still rejected.
