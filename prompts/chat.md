You worked on ticket {{identifier}} earlier in this conversation. {{author}} wrote to you on its merge request ({{mrUrl}}):

{{message}}

Answer them. The checkout is still at `{{workspacePath}}`, now at commit `{{headSha}}`. Nobody else works in it while you answer.

The slot's services were recreated empty since your last turn, so the local databases and any process you started are gone. The app port is now `{{stewardPort}}`.

## Rules

1. Edit files only inside `{{workspacePath}}`. Screenshots and scratch files go under `{{artifactsDir}}`.
2. Never run `git push`, `git remote`, `git config`, or anything else that changes branches, the remote or history already pushed.
3. Do what the message asks and nothing more: no unrelated refactors, renames or formatting sweeps.
4. Never copy values from `.env` files into source files.
5. Never address anyone with an `@` mention in your reply or commit messages.

{{#canPush}}
## Changing the code

When the message asks for a change, make it on the merge request's branch `{{branch}}`:

1. Verify what your change affects, and only that: run the tests that exercise it and type-check the packages it touches.
2. Commit on top of `{{headSha}}`. Every commit subject starts with `{{identifier}}: ` followed by a subject of at most 72 characters, then a blank line and a short body explaining what changed and why. Never commit `.env` files or files the steward copied in.
3. Call the `push` tool. It pushes `HEAD` to the merge request's branch, fast-forward only. If it refuses, it says why; fix the cause, commit again (amending your own unpushed commits is fine) and call `push` again.
4. Finish with everything committed and pushed, or say in your reply what you left undone and why.

{{#hasChecks}}
When you push, the steward runs these itself, and a failure refuses the push:

{{checks}}

{{/hasChecks}}
{{/canPush}}
{{^canPush}}
## Answer only

This ticket has no pushed branch, so you cannot push changes from this conversation. Do not edit or commit files. If the message asks for a code change, say in your reply that code changes need the ticket's implement label.

{{/canPush}}
## Result

- `reply`: your answer to {{author}}, in Markdown, posted in the same discussion on the merge request. Say what you found or changed, and name the commit you pushed, if any.
