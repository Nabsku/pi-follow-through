# Design

## The problem

An agent can finish the immediate step that produced its last answer and still leave the user's request unfinished. A follow-up should help only when the agent can do more useful work now. It should not turn a completed answer into an excuse to keep going.

## Event flow

1. Pi emits `agent_end` when a low-level run ends. The extension keeps the last assistant message from that run.
2. Pi emits `agent_settled` after retries, compaction, and queued continuations are finished. The extension also skips runs whose `subagent` tool result reports an async workflow still running.
3. The extension builds a small state object from the active session branch.
4. It asks Jev for a `noul` probability plus three `choice` answers: the active user request, an exact unfinished-evidence candidate, and the work status.
5. The extension validates that the selected request and evidence IDs exist in the submitted state, that the status is `incomplete`, and that the state contains a final-output evidence candidate.
6. If the probability reaches the configured threshold (default `0.80`), the progress differs from the last nudge, no delegated workflow is pending, and the session is still idle, it sends the continuation message.

The second idle check matters. A user may submit another request while Jev is evaluating the previous answer. In that case the old evaluation must not inject a message into the new run.

## State sent to Jev

The evaluator receives four useful views of the run:

- `task`: recent user requests;
- `tool_calls`: recent tool names and arguments;
- `recent_transcript`: recent user, assistant, custom, and tool-result text;
- `final_output`: the assistant's final text.

The state also includes `previous_nudge` when a recent user message contains the extension's continuation text. That lets Jev distinguish new progress from a repeated promise or blocker.

`request_candidates` contains recent user requests, excluding the extension's own nudge. `evidence_candidates` contains exact non-empty lines from the current final assistant output. Jev selects IDs from those arrays instead of generating citations. The extension rejects missing or unknown IDs. Requiring evidence from the final output is intentionally conservative: silent unfinished work is a false negative rather than an automatic false positive.

The extension does not include thinking blocks in the text fields. Tool arguments and tool output can still contain sensitive data, so the request should be treated as an external data transfer.

`followThrough.includeToolData` defaults to `true`. When it is `false`, the
extension omits both `tool_calls` and tool-result text from the state. The
setting can be configured globally or per project; project settings override
global settings.

## Why Jev

The main model should do the work. Jev only answers a narrow decision question. The extension keeps the decision in code: the threshold, stale-run check, mode check, and failure behavior do not depend on another generated paragraph.

The `0.80` threshold is a secondary policy gate, not proof by itself. The evidence and status answers must pass first. Revisit it with real false-positive and false-negative examples.

## Failure behavior

- No TypeSafe key: do nothing.
- HTTP error or malformed answer: log a warning and do nothing.
- Missing, unknown, or contradictory evidence answer: do nothing.
- Request takes longer than two seconds: abort it and do nothing.
- The run fails or is aborted: do nothing.
- The session is in print or JSON mode: do nothing.
- A new run starts before Jev answers: discard the old answer.

The hook fails open. A problem with Jev must not stop the user's Pi session.

## Non-goals

This extension does not:

- create tasks or manage a backlog;
- decide what work the user wants;
- bypass a request for permission or missing information;
- expand the scope of a request;
- run an unbounded autonomous loop.

The continuation prompt repeats the scope rule because the decision model and the working model have different jobs.
