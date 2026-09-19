# Contributing

Keep changes small and easy to inspect.

Before opening a pull request, check that Pi can load the extension:

```sh
pi --offline -e ./extensions/follow-through.ts --list-models
```

If you change the evaluator prompt or threshold, test both sides of the decision:

- unfinished, authorized work should trigger a nudge;
- completed work, user choices, permission gates, external blockers, and repeated promises should not.

Do not commit API keys, session files, transcripts, or tool output from private projects.
