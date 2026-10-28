You implemented this ticket earlier in this conversation. This is round {{round}} of {{maxRounds}} of review on ticket {{identifier}}: the steward pushed your change as a merge request, and the automated reviewer scored it {{score}}/5. The checkout is still at `{{workspacePath}}`, now at commit `{{headSha}}`. Nobody else works in it.

Your job is to address what the review found. You edit files; the steward verifies your work, commits it, and pushes. A person reviews the merge request.

The slot's services were recreated empty since your last turn, so the local databases and any process you started are gone. The app port is now `{{stewardPort}}`.

## Review summary

round {{round}} of {{maxRounds}}, score {{score}}/5. The reviewer's summary, verbatim:

{{summary}}

Treat findings that appear only in this summary as work too, even when they have no thread below.

{{#hasFindings}}
## Findings

Each finding is a discussion thread on the merge request.

{{#findings}}
### Thread `{{discussionId}}` at {{location}}

{{body}}
{{#hasSuggestion}}

Suggestion:

```
{{suggestedCode}}
```
{{/hasSuggestion}}

{{/findings}}
For every thread, either fix it or decline it with a specific reason. The choice is yours: take a finding only when it is right for this code, and when it is not, say why in the reply. Each thread needs a reply in `threads`, addressed to the reviewer by what the code does, never by mentioning anyone with `@`.

{{/hasFindings}}
{{^hasFindings}}
There are no open threads. Work from the summary and the CI failures; `threads` is empty.

{{/hasFindings}}
{{#hasCiFailures}}
## CI failures

{{#ciFailures}}
### {{name}} (stage {{stage}})

{{webUrl}}

```
{{logTail}}
```

{{/ciFailures}}
{{/hasCiFailures}}
{{#hasPersonCommits}}
## Commits a person added since the last round

{{#personCommits}}
- {{.}}
{{/personCommits}}

Keep their changes; build on them.

{{/hasPersonCommits}}
{{#hasNewComments}}
## New comments on the merge request

{{#newComments}}
**{{author}}:** {{body}}

{{/newComments}}
{{/hasNewComments}}
## Rules

1. Edit files only inside `{{workspacePath}}`. Screenshots and scratch files go under `{{artifactsDir}}`.
2. Never run `git commit`, `git push`, `git remote`, `git config`, or anything else that changes history, branches or the remote. `git status`, `git diff` and `git log` are fine.
3. Keep the change scoped to the findings and failures: no unrelated refactors, renames or formatting sweeps.
4. Verify what your change affects, and only that: find the consumers of the symbols you changed, run the tests that exercise them, and type-check the packages they live in. Do not run the whole repository's tests, lint or build. A failure that already exists on the base branch goes in `summary`; do not fix it.
5. Never copy values from `.env` files into source files.
6. Never address anyone with an `@` mention in replies or commit messages.

{{#hasChecks}}
After you finish, the steward runs these itself, and a failure hands the ticket back:

{{checks}}

Do not repeat them across the repository; spend your own checks on behaviour.

{{/hasChecks}}
## Result

- `outcome: "changed"` when you edited files to address findings or failures. Write `commitMessage` as a subject line of at most 72 characters (no ticket ID), a blank line, then a short body.
- `outcome: "no_changes"` when you edited nothing because you declined every thread. Every thread must be `declined`; leave `commitMessage` empty.
- `outcome: "failed"` when you tried and could not get to a working change. Put what you tried, what failed and where you stopped in `failureDetail`.
- `threads`: one entry per thread above, with its `discussionId`, `action` (`fixed` or `declined`) and a non-empty `reply` that says what you did or why you declined. No duplicates, none missing.
- `summary`: a short account of the round for the merge request.
- `checksRun`: each command, its result, and why it is in scope.
- `failureDetail`: null unless the outcome is `failed`.
