---
name: holistic-review-resolution
description: Use when addressing code review feedback, PR comments, reviewer findings, or repeated review iterations.
---

# Holistic Review Resolution

## Objective

Treat review comments as signals of possible underlying
implementation flaws, not merely requests for local edits.

The goal is the smallest COMPLETE correction that resolves
the root cause without introducing unnecessary refactoring.

## 1. Understand before editing

For each substantive review finding:

1. Read the complete finding and surrounding context.
2. Identify the violated requirement, invariant, or
   architectural assumption.
3. Inspect the implementation that produced the issue.
4. Determine WHY the original approach was flawed.
5. Verify the finding against actual code and behavior.
   Do not assume every reviewer comment is correct.

Do not modify code until the issue is understood.

## 2. Investigate the blast radius

Determine whether the same underlying problem exists in:

- Other branches of the affected implementation
- Other callers or consumers of the affected abstraction
- Related functions and modules
- Similar implementations introduced by the current change
- Shared interfaces, contracts, and invariants

Use targeted searches, call-site inspection, and tests.

Distinguish confirmed violations from speculative risks.
Do not expand into unrelated pre-existing code solely
because it looks similar.

## 3. Select the smallest complete fix

Prefer fixing the underlying abstraction or invariant
over adding patches at individual symptom locations.

A complete fix must address all confirmed manifestations
within the authorized scope.

Do not:
- Special-case the exact example in the review comment
- Add redundant guards that conceal a broken abstraction
- Duplicate a fix across callers when a shared fix is safer
- Introduce unrelated refactors or speculative abstractions
- Optimize for minimizing changed lines at the expense
  of correctness

## 4. Scope assessment and escalation

Classify the proposed fix:

LOCAL:
- Contained within the affected component
- Preserves existing contracts and architecture
- No significant new dependencies or behavioral changes
- Proceed autonomously

CROSS-CUTTING:
- Requires changes across multiple components but remains
  within the original task's intended behavior
- Proceed only if the changes are bounded and clearly
  covered by the existing task authorization
- Otherwise escalate

ARCHITECTURAL:
- Changes public interfaces or shared contracts
- Introduces or replaces architectural abstractions
- Alters persistence models, data flows, or ownership
- Changes behavior outside the original task scope
- Requires a substantial migration or broad refactor
- Always escalate before implementation

When uncertain about authorization, escalate.

## 5. Escalation protocol

If a broader refactor is necessary:

STOP before implementing the expanded change.

If operating as a child agent, ask the parent agent.
If operating as the parent, ask the human.

Provide:

- Review finding and verified root cause
- Evidence of the broader problem
- Affected components and expected blast radius
- Option A: minimal contained correction
- Option B: broader architectural correction
- Recommendation and tradeoffs
- Explicit decision required

Do not silently choose the architectural option.

If no response is available, leave the issue unresolved
and report it as BLOCKED. Never report an unapproved
partial workaround as a completed fix.

## 6. Verification

Before declaring a finding resolved:

1. Add or update a regression test demonstrating the
   underlying failure, where practical.
2. Confirm the test fails against the flawed behavior.
3. Implement the selected correction.
4. Run relevant tests and inspect the results.
5. Revisit all confirmed affected paths.
6. Review the final diff against the original requirement.
7. Check that the fix did not introduce additional
   architectural inconsistencies.

## 7. Completion report

For each finding, report:

- Finding: what the reviewer identified
- Root cause: why the issue existed
- Scope: what related code was inspected
- Resolution: how the underlying problem was corrected
- Evidence: tests or other verification performed
- Status: RESOLVED / DISPUTED / BLOCKED

Never mark a finding RESOLVED merely because the
specific line mentioned in the comment was changed.

## 8. Repeated review feedback

If a reviewer reports the same root problem again,
or a previous correction generates a closely related
finding:

STOP incremental patching.

Reevaluate the original implementation strategy.
Investigate whether the design itself is incorrect.
Escalate if a different approach is required.
