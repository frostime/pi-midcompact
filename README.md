# pi-midcompact

[简体中文](./README.zh-CN.md)

**Attention-aware mid-context compression: compress the noise, keep the signal.**

“Attention-aware” borrows the core idea of neural attention: keep in working context what future work still needs to attend to, rather than deciding from message age alone. A long session does not become stale uniformly. Exploratory reads, failed attempts, routine tool output, and implementation work that is already complete can occupy most of the context window after their value has largely expired. A user requirement, hard-won decision, or unresolved failure from much earlier may still need to remain verbatim.

Pi's built-in `/compact` behaves like **prefix compaction**: it turns an older contiguous prefix into one summary and retains a recent tail. That is appropriate automatic maintenance, but the cut itself does not distinguish a dispensable old exploration from an older decision worth keeping raw.

The name `pi-midcompact` points to the other option: **mid-context compression**. It compresses selected spans inside the active context while leaving valuable raw context on either side in place, and preserves the original session history for recall.

- Choose exactly which conversation ranges to compress.
- Review the proposed boundaries and summaries before anything changes.
- Keep the original Pi session entries available for later recall.
- Keep compression local to the current session-tree branch.

## What it does

At a natural checkpoint, `pi-midcompact` freezes the active session leaf as an anchor and opens a separate transaction. The Agent proposes ranges for completed low-value phases, preserves load-bearing messages verbatim, and prepares a draft for review. Nothing changes until you explicitly commit the plan.

### User-directed depth, Agent-designed plan

The workflow is **Agent-driven but user-directed**. You describe the desired retention depth and what must remain visible; the Agent examines the frozen anchor, discusses trade-offs with you, and drafts selective ranges and summaries. You do not need to select atom IDs yourself.

> “I only want to reclaim roughly 30% of the stale context. Do not compress aggressively; keep the reasoning behind earlier decisions verbatim.”

That is planning guidance, not an enforced token target: semantic importance wins over an exact percentage. The Agent turns it into a reviewable proposal—selected ranges, explicit `KEEP` holes, and summaries—then you approve, revise, or reject it before committing.

### A selective projection, prepared on a temporary branch

`/midcompact start` freezes the current session leaf as an **anchor**. Planning happens on a disposable child branch, so the discussion used to create and edit the draft never becomes part of the committed working context.

```text
Frozen anchor: raw session history

  [early exploration]──[decision to KEEP]──[routine tool output]──[latest work]  ◀ anchor
         ╰──── d1 ────╯                       ╰──── d2 ────╯

Planning is isolated on a temporary branch:

  ... [latest work] ──┬── [transaction] ── [draft v1] ── [draft v2]  ◀ review / edit
                      │                    (abandoned at commit)
                      └── [midcompact-state]                         ◀ committed leaf
                            (reviewed selection metadata, not a model message; written only by /midcompact commit)

Later model requests see a selective projection:

  [summary d1]──[decision to KEEP]──[summary d2]──[latest work]

The raw session JSONL still contains:

  [original d1]──[decision to KEEP]──[original d2]──[latest work]
```

### A reviewed draft can reclaim meaningful context

The browser review captured below selects **42 of 73 atoms** in **2 ranges**: approximately **31.0k → 488 tokens**, for an estimated **30.6k-token reduction**. The other 31 atoms remain unselected and visible as raw context. Click either image to open it at full resolution.

<p align="center">
  <a href="./figures/review-webui.png">
    <img src="./figures/review-webui.png" alt="Browser review UI showing 42 of 73 atoms selected across two compression ranges" width="49%">
  </a>
  <a href="./figures/review-tui.png">
    <img src="./figures/review-tui.png" alt="Native TUI review showing a selected compression range and its retained atoms" width="49%">
  </a>
</p>

<p align="center"><sub>Editable browser review UI · Native Pi TUI review</sub></p>

### Prefix compaction versus mid-context compression

Both mechanisms preserve the stored JSONL history, but they decide what later model requests see in different ways:

```text
Pi built-in /compact — automatic threshold or one manual command

  [older contiguous history────────────────────][recent tail]
                         │
                         ▼
  [one compaction summary──────────────────────][recent tail]

pi-midcompact — mid-context compression, review, then human commit

  [stale phase]──[load-bearing decision]──[routine output]──[recent work]
       d1                  KEEP                  d2
        │                                         │
        ▼                                         ▼
  [summary d1]──[load-bearing decision]──[summary d2]──[recent work]
```

| | Pi `/compact` | `pi-midcompact` |
| --- | --- | --- |
| Starts | Automatically near the context limit, or with `/compact` | At an explicit natural checkpoint with `/midcompact start` |
| Selects | One older contiguous prefix; keeps a recent token-budgeted tail | One or more reviewed ranges, including non-contiguous ranges and `KEEP` holes |
| Planning | Optional one-shot instruction to focus the generated summary | User states scope and retention depth; the Agent discusses trade-offs and drafts selective ranges and summaries |
| Decision gate | Generates a compaction checkpoint directly | Draft → TUI or browser review → explicit human `/midcompact commit` |
| Best fit | Automatic context maintenance and overflow recovery | Deliberate cleanup of completed phases while retaining specific decisions verbatim |

`pi-midcompact` does not disable or replace Pi's automatic compaction; it gives you a separate, human-reviewed way to make selective reductions. See [Pi's compaction documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) for the built-in mechanism.

## Install

From npm:

```bash
pi install npm:pi-midcompact
```

From GitHub:

```bash
pi install git:github.com/frostime/pi-midcompact
```

Restart Pi or run `/reload` after installation. The extension is built for Pi `0.84.x`.

## Use It

Start a transaction at a natural breakpoint: the current work is complete enough to summarize, and Pi is idle. The current point becomes a frozen **anchor**. The Agent plans against that snapshot, so later planning discussion cannot accidentally become part of the compressed working context.

### 1. Set the compression checkpoint

Run:

```text
/midcompact start
```

Pi asks for confirmation, then creates a temporary transaction after the anchor and tells the Agent how to plan the compression. No conversation is changed yet. You can include the initial scope in the same command:

```text
/midcompact start Compress the early repository exploration, but keep user requirements verbatim.
```

### 2. Discuss what to compress with the Agent

Describe the goal in normal language. For example:

```text
Compress the early repository exploration and routine command output.
Keep the user's requirements, the rejected database decision, and the final validation errors verbatim.
Reclaim roughly 30% of the stale context, but preserve semantic distinctions rather than chasing an exact token number.
```

The Agent locates relevant parts of the frozen conversation, proposes one or more ranges, and writes a summary for each range. You can ask it to preserve a specific message, split a range, or revise a summary.

### 3. Review the proposal

Run:

```text
/midcompact review
```

In interactive mode, the native TUI displays the frozen conversation as a linear timeline. Each item is marked either `KEEP` or as belonging to a proposed range. Review the range boundaries and the summary that will replace each range.

For RPC, print, or other no-TUI modes, use the editable local browser interface instead:

```text
/midcompact review-webui
```

You can edit a selected summary or topic, remove a range, and switch between compression ranges in either review surface. To change range boundaries or leave an important hole uncompressed, tell the Agent what to keep and ask it to revise the plan, then review it again.

### 4. Commit the reviewed compression

When the plan is correct, run:

```text
/midcompact commit
```

This is deliberately a human command. The Agent cannot commit compression itself.

Pi returns to the anchor, discards the temporary planning branch, stores the reviewed compression state, and resumes work from the committed branch. Future model requests receive the selected old ranges as summaries instead of raw messages.

### 5. Continue working or abort

Keep working normally after committing. If you decide not to compress, run:

```text
/midcompact abort
```

This returns to the anchor and discards the transaction without changing the active context.

## Native TUI Controls

Inside `/midcompact review`:

```text
n/p or Left/Right  select a proposed range
Up/Down, j/k       scroll
PgUp/PgDn          page
x                  expand the selected range's atoms
e                  edit the selected summary
t                  edit the selected topic
d                  remove the selected range
Enter/Esc/q        close
```

## Commands

| Command | Result |
| --- | --- |
| `/midcompact start [instructions]` | Confirms and starts a transaction at the current session-tree leaf, optionally with an initial compression focus. |
| `/midcompact review` | Opens the draft review timeline in the native TUI; in non-TUI modes, points to `review-webui`. |
| `/midcompact review-webui` | Starts an editable local browser review page; works without a TUI. |
| `/midcompact commit` | Commits the reviewed draft. Human only. |
| `/midcompact abort` | Abandons the transaction and returns to the anchor. |
| `/midcompact status` | Displays the current draft, or the committed compression state on this branch. |

The extension shows planning status in Pi's footer only while a transaction is active. It disappears after commit or abort.

## Guarantees and Limits

- **Original history is retained.** Compression changes what later model requests see, not the stored Pi messages.
- **Fail-open projection.** If an exact reviewed sequence no longer resolves, the extension sends the raw history unchanged rather than removing uncertain content.
- **State is branch-local.** Navigating with `/tree` to a point before a committed state restores raw history; returning to its descendant restores the projection.
- **Human review is required.** The Agent can propose a plan but cannot execute `/midcompact commit`.
- **Tool protocol is protected.** Unknown, incomplete, or orphaned tool exchanges are not compressible.
- **Repeated transactions work.** Later transactions can compress newly accumulated raw context; existing summaries remain protected.
- **Native Pi `/compact` interaction needs more real-session validation.** Avoid relying on mixed automatic/native compaction behavior for critical work until it has been exercised in your environment.
- **Provider and extension interoperability needs more real-session validation.** Unusual message shapes, third-party context-transform ordering, and long-lived exact message fingerprints have not been broadly exercised.
- **Very long sessions are not stress-tested.** Large review snapshots and repeated block accumulation may eventually require consolidation.
- **Browser review is local.** `review-webui` binds to loopback, opens an editable review page, and keeps the draft mutations in the same branch-local transaction as the native TUI.
