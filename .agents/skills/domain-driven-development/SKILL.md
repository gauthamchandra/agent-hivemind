---
name: "domain-driven-development"
description: "Shape new code around the domain's own language with clean seams: one reason to change per unit, SOLID applied through the project's layers and boundaries, and abstractions that earn their place. This skill should be used when adding or reshaping a service, module, interface, table, endpoint or command, when a file or function starts doing two jobs, when naming a new domain concept, or when a reviewer calls an abstraction or its placement wrong. Triggers: domain-driven design, DDD, SOLID, single responsibility, abstraction, aggregate, value object, ubiquitous language, god class, refactor, where does this code go."
---

# Domain-driven development

Put each piece of behaviour where the domain says it lives, name it in the domain's words, and
give it one reason to change. SOLID is the test for where code goes. It is not a licence to add
types.

The project's own rules against speculative abstraction win over this skill. If the project
bans single-implementation interfaces, factories for one product, or layers added "for later",
this skill bans them too (see [Earn the abstraction](#earn-the-abstraction)).

## When to use this skill

- Adding or reshaping a service, module, interface, table, endpoint, or command.
- A file or function starts doing two jobs, or a name needs "and" to describe it.
- A new noun appears (a status, a kind, an outcome, a table) that no doc defines.
- A reviewer says "wrong abstraction", "wrong layer", or "why is this here?".

Skip it for a bug fix, a doc change, or a change that follows an existing pattern, such as a new
row in a rules table. A change that follows a pattern needs none of this ceremony.

## Before writing code

Write four lines in the plan, the pull request description, or a design note. If one cannot be
written, the design is not ready.

1. **The term.** "A _term_ is …. It changes when …." Use the words the project's docs and code
   already use. Define a new noun once, where the project keeps its glossary, before any code
   uses it.
2. **The home.** Name the layer or module the unit belongs in, from the project's own
   architecture map. With no map, use this order: pure domain rules with no I/O, then
   application services that orchestrate, then adapters for the database, network and
   framework. Dependencies point inward. A pure rule never imports I/O.
3. **The units and the one reason each changes.** Describe each file in one sentence with no
   "and". The usual reasons to change are a domain rule, a storage detail, a wire format, and
   a vendor quirk. A unit that answers to two of them splits on that seam.
4. **What is not abstracted.** The cuts made on purpose.

## Earn the abstraction

Add a type, interface, module or helper only when all of these hold:

1. It has a name in the domain's language.
2. It has one reason to change.
3. It has two or more callers, **or** it sits on a boundary the architecture already names,
   such as a layer edge.
4. A constraint, a test or a lint rule cannot enforce the same thing more cheaply.
5. The deletion test: remove it. If the complexity reappears in several callers, it earns its
   place. If it vanishes, delete it.

Reuse before adding. Scope an existing record of truth with a column before adding a parallel
table. A new table, kind or status needs a written reason why the existing one does not do.

## SOLID, in practice

| Principle | What it means | Example |
| --- | --- | --- |
| Single responsibility | One reason to change: the domain rule, the storage, the wire format, or the vendor quirk. | An `OrderService` that validates, prices, saves and emails has four reasons to change. Split on those seams. |
| Open/closed | A new case is a new member of a closed set or a new row in a table. The compiler lists every place to touch. | A new payment method is a new union member. A `switch` with an exhaustiveness check fails to compile until every case handles it. |
| Liskov | Anything behind an interface does what the interface promises. | Every `PaymentGateway`, the test fake included, passes the same contract tests. |
| Interface segregation | A unit asks for what it uses, not the whole dependency. | A function that reads an order's total takes the total or a read-only view, not the whole repository. |
| Dependency inversion | Inner layers depend on abstractions. One composition root, the place that starts the program, wires the concrete parts. | Pricing rules import no database client and no HTTP library. |

An interface is justified where a layer must not see a detail, such as domain rules that must
not see SQL. Inside one layer, two classes behind one interface are not a boundary. They are
the single-implementation interface the rule above rules out.

## Domain concepts

- **Ubiquitous language.** The same word in the code, the docs, the commands and the tables.
  Two words for one thing become one. Do not coin a status word the docs do not define.
- **Aggregate.** The unit that one lock or one transaction protects. A rule that must hold
  across rows lives inside one aggregate. Change one aggregate per transaction, and prefer a
  database constraint to a check in code.
- **Value objects.** Typed ids and parsed inputs. Parse at the edge (endpoint, command,
  message handler) into a typed input, so the inside never receives a raw JSON body, a
  string-keyed map, or a `kind: string`.
- **Events.** What happened is a named event kind. Its payload can live elsewhere. A parallel
  history beside an existing one needs a written reason.
- **Rules as data.** Who may do what, and which state may follow which, is a table that tests
  enumerate row by row. Do not hide a permission in an `if` inside a service.

## Smells and the seam that fixes each

| Smell | Seam |
| --- | --- |
| A service validates, decides, writes and notifies in one flow. | Split on the reason to change: a pure decision, then an orchestration that calls it. |
| A rule is repeated in every caller or every test. | Put it once at the seam all callers pass through, such as the data-access wrapper or a shared guard. |
| Client code builds URLs, paths or raw payloads. | A named client method (`sendMessage`, `listInbox`). Callers do not learn the wire format. |
| A "flag over config over default" rule is re-resolved in each consumer. | Resolve it once, at the edge that parses the input. |
| An `if` chain compares one value to three or more literals. | A `switch` over a closed type, with an exhaustiveness check. |
| A file was split into many small files only to pass a size limit. | Split on a seam, not on line count. A limit is a ceiling, not a target. If the change is still too big, split the pull request. |
| A new kind of thing gets its own table and history beside a similar one. | Scope the existing record, or write down why it cannot work. |

## Check before you finish

- Each new unit passes the one-sentence test and answers to one reason to change.
- Each new abstraction passes [the five tests above](#earn-the-abstraction).
- No new noun is undefined, and no two words name one thing.
- Dependencies point the way the project's layer rules say, and the linter agrees.
- The "not abstracted" line is true of the diff.
