---
name: tiered-model-workflow
description: Orchestrate coding work across model tiers instead of doing everything yourself at Sonnet-level cost — plan and review as Sonnet, delegate the actual code writing to a Haiku subagent, and only call in Opus when a bug survives a couple of real fix attempts or for one final whole-project QA pass at the end. Use this whenever the user asks to build, implement, add, or fix a nontrivial feature or bug in this repo — a new screen, a new API integration, a multi-file refactor, a "this is broken, fix it" report — even if they never mention models, tiers, or agents by name. Skip it for trivial one-liners (typo fixes, renaming a variable, a config value tweak, answering a question) where spinning up subagents would be pure overhead — just make the change directly.
---

# Tiered model workflow

The idea: your own reasoning (Sonnet) is the expensive, scarce resource here. Spend it on
the two things a fast model can't do well — deciding *what* to build and *judging whether it
actually works* — and hand the mechanical work of *writing* the code to a cheaper, faster
model. Only reach for the most expensive model (Opus) when something is genuinely stuck, and
once more at the very end for a fresh, skeptical look at the whole thing before you call it
done.

This only pays off for work with real substance — multiple files, a nontrivial feature, a bug
whose cause isn't obvious. For a one-line fix, just make the edit yourself; the overhead of
spawning and babysitting a subagent would cost more than it saves.

## The loop

```
Plan (you)
   → Implement (Haiku agent)
      → Review (you)
         → passes?  → next plan step, back to Implement
         → fails, first attempt? → send feedback back to a new Haiku agent, retry Implement
         → fails again on the same issue? → escalate to Opus agent to fix it directly
      → (after Opus fixes) → Review (you) → continue the loop
… once every planned step is implemented and reviewed clean …
Final QA (one Opus agent, whole diff) → report to user
```

### 1. Plan — you do this, don't delegate it

Break the request into concrete implementation steps: which files change, what the new
functions/components/interfaces look like, what the acceptance criteria are for each step
("the endpoint returns 404 for an unknown id", "the button disables while the request is in
flight"). This plan is what makes the next step work with a cheap model — Haiku will follow a
precise spec well but shouldn't be trusted to invent the architecture or resolve ambiguity on
its own. The more precisely you specify a step, the less back-and-forth the loop needs.

Keep the plan in your own head/todo list, not in a file, unless the user asked for a written
plan.

### 2. Implement — delegate to a Haiku agent

For each step (or a small batch of closely related steps), spawn an agent with `model: "haiku"`:

```
Agent({
  description: "Implement <step>",
  model: "haiku",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: "<self-contained spec: exact files, exact interfaces, exact behavior,
            relevant existing code context, acceptance criteria. No open design
            decisions — those were already made in the plan.>"
})
```

Run it in the foreground (`run_in_background: false`) — the loop is sequential, your next
action (review) depends on this result, and there's nothing else useful to do while it's
running. Write the prompt as a complete spec: Haiku wasn't part of your planning conversation
and has no context beyond what you put in the prompt. Vague prompts ("implement the feature we
discussed") produce vague, wrong code from a fast model much more often than from a strong one
— the discipline of a precise spec is what makes this tier split actually work.

### 3. Review — you do this, don't delegate it

Don't take the agent's summary at face value — read the actual diff, read the changed files,
and run whatever verifies correctness for this stack (build, typecheck, tests, a manual
exercise of the golden path). This is the same "trust but verify" standard you'd apply to any
subagent's work, just load-bearing here: Haiku is fast but will confidently claim success on
code that doesn't compile or that misses an edge case, so this step is the actual quality gate
for the whole workflow, not a formality.

If it's correct and matches the plan step's acceptance criteria: move to the next plan step
(back to Implement).

If it's wrong: decide whether you can just fix it yourself in one or two small edits (do that —
no need to round-trip through another agent for a trivial miss) or whether it needs another
real implementation attempt. For the latter, spawn a fresh Haiku agent with a prompt that
includes what was wrong and what to change — don't silently re-send the same spec expecting a
different result.

### 4. Escalate to Opus only when actually stuck

Call in `model: "opus"` when either:
- the same bug or the same class of failure survives a second real fix attempt (i.e., you gave
  clear feedback and a retry still doesn't work), or
- while reviewing, you recognize the problem needs real root-cause reasoning — a race condition,
  a subtle state-management bug, something architectural — rather than another mechanical
  attempt.

Don't escalate on the first failure — most misses are just Haiku needing a clearer spec, which
you can supply yourself in the retry prompt. Opus is for when the loop has stopped converging.

Scope the Opus agent tightly to the actual stuck problem, not the whole feature — this keeps it
fast and cheap relative to redoing everything:

```
Agent({
  description: "Fix <specific stuck issue>",
  model: "opus",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: "<the specific bug, what's been tried and how it failed, relevant files,
            expected behavior>"
})
```

After Opus fixes the issue, review its change yourself the same way (step 3), then drop back
into the normal Haiku-implements / Sonnet-reviews loop for whatever's left in the plan. Opus is
a rescue for one problem, not the new default implementer — reverting to Haiku afterward is
what keeps this workflow cheaper than just using one strong model throughout.

### 5. Final QA — one Opus agent, once, over the whole thing

Once every planned step is implemented and has passed your review, spawn exactly one more Opus
agent to do a holistic pass over the *entire* diff — not per-step, the whole feature/fix as a
unit. This catches what step-by-step review can miss: inconsistencies between pieces that were
each individually fine, integration gaps, edge cases that only show up when the parts combine.

```
Agent({
  description: "Final QA pass",
  model: "opus",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: "Review the complete set of changes for <feature/fix>. Here is the plan
            it was implementing: <plan>. Here is the full diff: <diff or file list>.
            Look for correctness bugs, edge cases, and inconsistencies between parts
            that were built separately. Run the build/tests if available. Report
            findings; do not fix anything yourself unless a finding is a one-line fix."
})
```

If it surfaces real findings, fix them yourself or via another quick Haiku/Opus round as
appropriate (judgment call based on how gnarly the fix is), then you're done — no need for a
second full QA pass unless the fix was substantial enough to warrant one.

### 6. Report to user

Summarize: what was built, which steps needed a retry, whether Opus was pulled in and why (if
never, say so — it means the loop converged cleanly), and what the final QA pass found and how
it was resolved. Keep it to what the user needs to know to trust the result, not a full
transcript of the loop.
