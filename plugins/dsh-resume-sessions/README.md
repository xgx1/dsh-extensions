# dsh-resume-sessions

Host-side profile-bundle overlay: a session whose turn was still open when the
Harness stopped is cold-resumed once after the next boot and handed one
follow-up message, so the model continues the interrupted work instead of the
log simply ending with an `interrupted` closer.

Zero `deepseek-harness` source changes: it observes `session/event`, keeps the
in-progress set in a Turso database under the Harness home, and drives the
shipped `sessionController.resolveAgent` cold-resume seam after startup.

## What it does

- `turn/start` → the session id enters `<DSH_HOME>/resume.db` (subagent children
  are never tracked: their lifecycle belongs to subagent routing).
- `turn/end` → the row leaves, except for a host stop: `aborted` with reason
  `disposed` (that is what the loop appends when the process is torn down
  mid-turn). A completion, a failure, and a human cancel all drop the row.
- Once the launcher reports successful startup (`appReady`, or Loader
  settlement without it), the sweep reads the set and resumes it **serially**,
  spaced by `delayMs`. Each attempt is one delivery: the resumed turn re-keeps
  its row while it runs.

## Safety boundaries

Each is a hard skip and is logged at `warn`/`info`; none of them can fail the
boot:

| Skip | Why |
| --- | --- |
| stored header absent | the session no longer exists |
| `header.origin === 'subagent'` | subagent routing owns that session |
| archived session | the user archived the conversation |
| live goal with phase other than `active` | a paused/blocked/completed goal is a decision |
| already-live agent | nothing to resume |
| `SessionAlreadyOwnedError` / lock held | another writer owns it; skipped with a warning |
| any thrown error in one conversation | contained per conversation |

## Configuration

```yaml
- id: resume-sessions
  name: 'dsh-resume-sessions'
  config:
    enabled: true   # false: keep tracking, resume nothing
    delayMs: 2000   # 0..60000, spacing between two resumed conversations
```

Default is **on** (`enabled: true`). Turning it off is a product decision the
deployment owns, not a bug: with `false` the plugin still tracks turn
boundaries and simply never sweeps.

## Known Limits and Deferred Work

- The sweep resumes only what was mid-turn at shutdown. A session that was
  idle but had queued inbox work is not resumed; the queue lives in memory.
- The follow-up is one message per session, not a re-run of the interrupted
  tool call: the model is told the turn is closed and to re-check any
  half-finished external state.
- No UI. The resumed turn shows up as an ordinary turn in the conversation.
- `delayMs` spaces the sweep, it does not rate-limit model calls beyond that.
