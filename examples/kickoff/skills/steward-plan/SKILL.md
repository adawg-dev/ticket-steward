---
name: steward-plan
description: Use at the standard and design levels, before touching code, to write the ticket's implementation plan to the artifacts directory and then execute it task by task.
---

<!-- Adapted from Superpowers `writing-plans` (MIT, Copyright (c) 2025 Jesse Vincent); the license is at the end. -->

# Writing and executing a plan

A plan is the set of decisions an implementer could not make alone: which files, which names and signatures, which
values from the ticket (or the design), and which checks prove each task. Write those down, then work through them.
YAGNI. Test first where the code has tests. Commit after every task.

## Where it goes

Save the plan to `$ARTIFACTS_DIR/plan.md`, where `$ARTIFACTS_DIR` is the artifacts directory your prompt names. Never
write it inside the checkout and never commit it. The same goes for any design it follows.

## Before the tasks

Map the files the change will create or modify, and what each is responsible for. Follow the codebase's existing
patterns and file layout; do not restructure files the ticket does not need changed. Search for code that already does
part of the job before planning anything new.

## Header

```markdown
# <ticket identifier>: <title>

**Goal:** <one sentence>
**Approach:** <two or three sentences>
**Design:** <path to design.md, or "none">
```

## Tasks

A task is the smallest change that carries its own check: fold setup and configuration into the task that needs them,
and split only where one task could be right while its neighbour is wrong. Each task ends with something you can verify
on its own.

````markdown
### Task N: <what it delivers>

**Files:**
- Create: `exact/path/new.ts`
- Modify: `exact/path/existing.ts`
- Test: `exact/path/existing.test.ts`

**Verify:** `<command>`, expected `<result>`

- [ ] Write the failing test: `<test name>`, asserting `<exact values>`.
- [ ] Implement `<signature>` in `<file>`.
- [ ] Run the check; it passes.
- [ ] `steward-simplify` on the task's diff, then re-run the check.
- [ ] Commit.
````

A step is done when it leaves exactly one reasonable thing to write: a test step names the test and its assertions; a
code step names the signature, the file and any values the ticket pins; a verification step names the command and the
result that means it passed. Leave function bodies out unless the signature and the test do not determine them. A plan
longer than the code it describes has written the code instead; a step like "handle edge cases" or "add tests" decides
nothing. Fix both.

## Self-review

Check the plan once against the ticket (and the design, if there is one):

1. **Coverage.** Every requirement has a task. Add a task for any that has none.
2. **Steps.** No step is vague, and none spells out code its signature and test already determine.
3. **Names.** Types, functions and fields are named the same in every task that uses them.
4. **Proportion.** The plan is shorter than the change it describes, and no longer than a ticket of this size needs.

Fix what you find in place.

## Execute it

Run `steward-simplify` on the plan, then work through it yourself, in this session, one task at a time:

1. Implement the task's steps.
2. Run its verification and fix what fails.
3. Run `steward-simplify` on the task's diff (`git diff HEAD` before you commit, plus the untracked new files
   `git status --short` lists as `??`), then re-run the verification.
4. Commit it, following the prompt's commit rules. `plan.md` and `design.md` are never in a commit.

When a task shows the plan was wrong, update `plan.md` and carry on. When the work turns out bigger than the plan (more
packages, a migration, auth, billing), that is a step-up trigger; follow the prompt.

---

Portions of this skill are adapted from Superpowers (https://github.com/obra/superpowers), `skills/writing-plans`:

> MIT License
>
> Copyright (c) 2025 Jesse Vincent
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
