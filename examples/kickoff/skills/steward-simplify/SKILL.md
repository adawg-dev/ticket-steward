---
name: steward-simplify
description: "Use after writing a plan, after each task, and on the final diff: cut what the ticket does not need."
---

# Simplify

You review your own work for what it does not need, then cut it. This is a quality pass, not a bug hunt: do not go
looking for defects, and do not widen the change. Everything you do stays inside the ticket's scope.

## On a plan

Read the plan against the ticket and cut:

- tasks the ticket does not ask for;
- layers, options, settings, flags and abstractions with one caller or no caller yet;
- new helpers, types or modules where the code already has one that fits (search before keeping a new one);
- tasks that cannot be verified on their own: merge each into the task whose checks prove it.

Rewrite the plan in place. A shorter plan that still meets the ticket is the goal.

## On a diff

Run `git diff <from>...HEAD` (or `git diff` for uncommitted work) and read every hunk. For each, ask:

- **Reuse.** Does the codebase already have a function, component, type or pattern that does this? Use it, and delete
  the new one.
- **Simpler.** Can this be fewer lines, fewer branches or fewer moving parts with the same behaviour? Inline a helper
  or wrapper used once, drop an interface with one implementation, drop a parameter nobody passes, drop dead code and
  defensive checks for cases that cannot happen.
- **Efficiency.** Repeated work in a loop, a query or read that could be done once, an await chain that could run
  together, a copy that is not needed.
- **Altitude.** Is the code at the level of the code around it? Not a framework for one use, not a generic utility for
  one call site, not configuration for a value that never changes. Follow the file's own conventions.

Leave alone:

- code your change did not touch, even if it could be better (the scope rule wins);
- behaviour: a simplification must not change what the code does;
- naming and formatting the linter accepts.

## Then

1. Apply the fixes.
2. Re-run the checks of the task (or of the whole change, on the final diff). Fix what they report.
3. Say in one line what you cut, or that there was nothing to cut. Do not invent cuts to have something to report.
