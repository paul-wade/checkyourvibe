# 0034 — The dashboard as the conversation: design

## One store, not two

The open question in the requirements is whether the exchange and the comment
store are one record. They are one.

Comments already carry `id`, `author`, `body`, `status`, `created`, and an
optional `file`/`anchor`. An agent entry is a comment whose author is
`AGENTS`-side — the `AGENT_AUTHOR` constant that already exists so that an
agent's own replies do not appear in "needs you" or notify the agent about
itself.

A second store would be two records that can disagree about what was said. This
project reports that class of defect in other people's code; it should not ship
one.

What the comment record gains:

- `kind: 'note' | 'turn'` — a short note versus a recorded turn. Both are
  entries; the page renders them differently and `needsYou` continues to
  consider only open owner-authored notes.
- `refs?: { task?: string; file?: string; replyTo?: number }` — what the entry
  is about (R2.3). `replyTo` already exists.

Nothing existing changes shape, so the store stays readable by the current code
while the new fields fill in.

## The agent records its own turn, deliberately

R3.3 forbids scraping the terminal. The agent writes an entry when it has
something worth keeping — a decision, a finding, a question — through the same
API the page posts to, authored as the agent.

That means the transcript is *edited by construction*: it holds what was worth
recording rather than everything that scrolled past. R3.1 is satisfied because
only the agent writes the agent's entries, and R4.3 because an entry is written
when there is something to say and not to fill space.

The cost, stated: an agent that forgets to record leaves a gap. That is
preferable to a page full of tool calls nobody reads, and it is the same
trade-off the commit log already makes.

## Page order

Verdict, needs-you, in-progress, then the exchange (R1.3). Someone opening the
page to find out whether something is broken reads the top and stops. The
exchange is what they read when the answer is "nothing is broken, what is
happening".

The `/activity` route keeps specs, commits and the changelog. It was split out
because the status page was six phone screens; adding a conversation to the top
must not undo that. The exchange is paginated to a recent window with the rest
behind a link.

## Writing back

The existing one-line `#gc` box becomes a textarea that accepts a paragraph
(R2.1) and posts to `/api/comment`, which already exists and already reaches the
watcher (R2.2). No new channel, no new endpoint.

## The documents surface

`/files` and `/view` are rendered but unstyled relative to the rest. The work is
design, not features: a reader navigating specs on a phone. Constraints that
bound it — server-rendered, no dependency, no client framework, and it must
degrade to readable text when CSS does not load, because that is what makes it
work over a phone connection on a train.

Specifically in scope: a document list that groups by spec rather than listing
paths flat; a reading measure that is not the full window width; headings that
can be jumped to; and the existing per-section comment anchors kept working,
since that is how a spec gets commented on in the first place.

## Not doing

- **A live model connection.** R4.1. The page is a record, not a prompt.
- **Streaming.** The 15-second poll that already refreshes the volatile panels
  is enough for a record that updates when a turn ends.
- **Markdown rendering of agent entries beyond what `renderStatusBody` already
  does.** It escapes first and allows inline code and bold. Widening that is a
  new injection surface for no gain.
