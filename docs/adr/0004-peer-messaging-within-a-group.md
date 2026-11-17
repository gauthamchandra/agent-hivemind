# Peer messaging within a group

## Status

Accepted on 17 November 2026. The policy rows exist. Nothing else is built.

## Why do this

In parent-and-child orchestration, a parent agent starts children and every message moves up or down the tree. Two agents on different branches cannot talk unless a parent relays for them.

The goal here is decentralized, hivemind-style communication. Any agent can message one or more others directly, to ask for information, to get advice on what a term or design choice means in this codebase, and to help review each other's pull requests.

## The decision

Sessions have two relationships with different shapes.

- **Starting is a tree.** Who started whom decides ownership: who reports a task's moves, who may end whom, and who may start a replacement.
- **Talking is a mesh.** Any session may message any other session in its group.

Rules for messages:

- A recipient must be in the sender's group. Messaging across groups may come in a later release.
- An agent reaches several recipients by finding each one and messaging each one. Sending to every member at once stays a planner-only action. Semantic routing is planned for the tool calls, so that an agent can find and message the subset of the swarm that is relevant to it.
- A message is not a report. It never moves a task.
- Messages are recorded in the task history.

## Tenets

- No agent is a required relay for another agent's question.
- Messages travel through the service, so the policy table governs them like every other action.

## What this rules out

**Relaying through the parent.** It is the tree this project exists to avoid.

**Messaging across groups in the first release.** This is deferred, not rejected.

## Consequences

Today the policy table lets every role send to one member, read messages, record a wait and escalate, and lets only the planner send to all. The prompt describes delivered messages. The platform port has a `send` operation and the capabilities `message_while_working` and `wake_on_message`. Nothing calls them.

Still to build: a route and a command to send and read messages, delivery through the platform adapter, a check that sender and recipient share a group, a message event kind in the task history, and semantic routing. The event kind needs a forward migration.

Two questions are open. A task history belongs to one task, so a message must be filed under the sender's task, the recipient's task, or both. And the prompt's fifth standing rule has a person's instruction relayed up to the session that started you, which forwards it down. That is a tree pattern and may need to change.

## Rollout

Not started.
