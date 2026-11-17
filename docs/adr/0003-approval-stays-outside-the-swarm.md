# Approval stays outside the swarm

## Status

Accepted on 17 November 2026.

## Why do this

A group of agents can review each other's pull requests. If that review counted as approval, the swarm would be judging its own work and deciding what is safe to merge. How much scrutiny a change needs depends on its risk, and that is the policy of the people who run the swarm. The swarm should not set it.

## The decision

A peer's review never counts as approval. It is advice to the task's own reviewer.

The service does not read, request or count pull-request approvals. It checks that a pull-request address is a web address and does not fetch it.

The `approved` task state says the task's own reviewer session signed off, and the prompt tells that reviewer to mark the pull request ready for review when it does. It is a handoff to whatever approval process the organisation runs. It is not a merge approval.

## Tenets

- The people who run the swarm own their approval process.
- The swarm hands a pull request over. It does not decide whether the pull request may merge.

## What this rules out

**A peer's review counting toward approval.** It would let the swarm approve its own work.

## Consequences

The intended setup, which the service does not provide, is many code-review bots plus an auto-approver. The auto-approver stamps low-risk pull requests and gates higher-risk ones for a person to approve.

The service cannot tell whether a pull request met your approval process before the reviewer reports the merge. It records the reviewer's report and the address it gave.

## Rollout

None. The service already works this way.
