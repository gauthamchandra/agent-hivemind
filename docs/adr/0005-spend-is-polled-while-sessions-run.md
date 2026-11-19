# Spend is polled while sessions run

## Status

Accepted on 17 November 2026. The poll is built. It runs from a timer in the worker process, under a lock so only one process polls at a time. The two follow-ups below, ending agents for context rot and ending agents that have passed the budget, are still open.

## Why do this

A group has a budget, and the service learns what the agents spent from the platform's usage readings. An agent can work for days. If usage is counted only when a session ends, a group can pass its budget by any amount before the service notices, and nothing stops the agents that are still running.

## The decision

A scheduled job runs on a fixed interval. The interval is recorded when the job is built. It reads the usage of every session still running on the platform and adds the increase to the group's spend. That includes released sessions, because release makes no platform call and the agent keeps running.

The final reading when a session ends stays, so the last stretch is counted. Starts and resumes are refused once spend reaches the budget, as they are today.

Two things are planned on top of this, each in its own pull request:

- A **reaper** role whose only job is to read compaction metrics and other signals that an agent has lost quality to context rot, and to end those agents.
- An extension of the scheduled job that ends agents once their group has exceeded its spending cap.

## Tenets

- Spend is measured while agents run, never only when they stop.
- Measuring and acting are separate steps. This decision is the measuring. Ending agents for cost or for context rot builds on it.

## What this rules out

**Reading usage only at session end.** It is what the service does today.

## Consequences

The service needs a scheduler. The process that drains the outbox runs the poll from its timer. Several processes can be up at once, so a lock row in the database decides which one polls.

Polling costs one platform call per running session per run, and a platform can rate-limit those calls.

One function applies a reading, for the poll and for the final reading alike. It adds only the increase over the stored usage, while holding row locks on the group and the session. Two overlapping runs therefore cannot count the same usage twice, and a smaller later reading changes nothing.

A reading clears `final_usage_pending`, the flag that says a session's final reading is still owed. A poll must not clear it for a reading taken while the session runs. Otherwise a poll that read usage before the session ended and applied it after the final read failed would clear the flag. The retry would then skip the final read, and the usage after the poll's reading would never reach spend. The poll clears the flag only for a session that has ended and whose platform stop has succeeded, because that reading is the final one. A missing reading leaves the flag set, and zero is a reading.

## Rollout

Built. The budget refuses the next start once a run has recorded that spend reached it. It does not stop running agents.
