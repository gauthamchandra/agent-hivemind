# One implementer per task

## Status

Accepted on 17 November 2026.

## Why do this

Most coding harnesses subscribe the agent to GitHub pull-request events. A harness is the program that runs an agent session and feeds it events and tools. Any activity on a pull request, from a bot or from a person, interrupts the agent and forces it to switch to that pull request.

With one pull request, those interruptions are the work. With several, activity on any one of them pulls the agent away from the others. At high enough activity the agent's context fills and the harness compacts it. Depending on the harness, the agent then hallucinates.

## The decision

- A child task has one implementer session at a time.
- A session belongs to one task for its whole life.
- A task has one changeset at a time. A changeset is the pull request for the task. A verification failure after the merge starts a new round of the same task, so rounds follow each other and never overlap.

The planner starts one implementer per child task, up to the group's cap on live implementers. The default cap is four.

## Tenets

- An agent sees one stream of pull-request events.
- Parallel work comes from more tasks and more sessions, never from more pull requests per agent.

## What this rules out

**One implementer taking several tasks.** It would use fewer sessions and cost less. It is the case this decision exists to prevent.

## Consequences

The service enforces part of this. A unique index allows one `starting`, `live` or `released` session per task and role, except for challengers, and a session row holds exactly one task. The same index limits reviewers and verifiers to one per task.

The service cannot enforce the rest. It cannot see how many pull requests an implementer opens for a task, because the evidence it takes is a web address and it does not fetch it. The prompt is the only guard against a second pull request.

More work means more tasks and more sessions, and the caps bound how many run at once. The planner has to cut the goal into pieces that are one pull request each.

## Rollout

None. The rule is already in effect.
