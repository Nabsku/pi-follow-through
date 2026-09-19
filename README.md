# pi-follow-through

`pi-follow-through` is a Pi extension that checks whether an agent has left useful work unfinished.

After a run settles, it sends the recent request, tool calls, transcript, and final answer to TypeSafe's Jev model. If Jev thinks the agent can make more progress without inventing work or waiting for the user, the extension sends a short continuation prompt.

## Install

```sh
pi install npm:pi-follow-through
```

Review the source before installing it. Pi extensions run with the permissions of the Pi process.

Set a TypeSafe API key in the environment that starts Pi:

```sh
export TYPESAFE_API_KEY=your_key_here
```

`TYPESAFE_AI_API_KEY` is accepted as a fallback. Restart Pi after changing the environment.

## Configuration

The default threshold is conservative:

```json
{
  "followThrough": {
    "threshold": 0.8,
    "includeToolData": true
  }
}
```

Put this in `~/.pi/agent/settings.json` for all projects or in
`.pi/settings.json` for one project. Project values override global values.
`threshold` must be between `0` and `1`. Set `includeToolData` to
`false` to leave tool calls and tool-result text out of the TypeSafe request.

## What it does

The extension runs after `agent_settled`, not after every model call or tool call. It asks Jev one typed yes/no question. At the configured threshold (default `0.80`) or higher, it sends this message:

```text
Continue useful work that is still within the user's request. Check for unfinished requested work and complete it now; do not invent follow-up work. If the request is complete, or progress needs user input, permission, or an external event, stop and say so.
```

The evaluator prompt treats short confirmations such as "Yes" and "Continue" as part of the earlier request. It also treats an explicit statement that implementation or review remains incomplete as evidence of unfinished work. A previous nudge is not enough on its own. The latest response must show new, actionable progress or a concrete next step.

The extension only sends nudges in TUI and RPC modes. It skips print and JSON modes, failed or aborted runs, and stale evaluator responses after a new run starts. A missing key, request error, or two-second timeout skips the nudge instead of interrupting Pi.

## Data sent to TypeSafe

The request can contain user prompts, source code, command lines, tool arguments, and tool output. By default, the extension sends:

- the last eight user requests, capped at 8,000 characters;
- the last 20 tool calls, capped at 8,000 characters;
- the last 20 transcript entries, capped at 24,000 characters;
- the final assistant output, capped at 8,000 characters.

These caps keep the evaluation request below Jev's context window. Truncated fields are marked in the request. Do not use the extension for sessions whose contents you do not want to send to TypeSafe.

With `includeToolData: false`, tool calls and tool-result text are omitted.

## Try it from a checkout

```sh
git clone git@github.com:Nabsku/pi-follow-through.git
cd pi-follow-through
pi -e ./extensions/follow-through.ts
```

The extension has no runtime dependency beyond the Pi extension API and the `fetch` implementation provided by the Pi runtime.

Run the local checks with:

```sh
npm install
npm test
```

## Design notes

See [docs/design.md](docs/design.md) for the event flow, failure behavior, and the reasons for the current limits.

## License

MIT. See [LICENSE](LICENSE).
