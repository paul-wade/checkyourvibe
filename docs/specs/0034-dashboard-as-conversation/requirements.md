# 0034 — The dashboard as the conversation

**Status:** draft
**Created:** 2026-08-30

The review dashboard on 4180 shows state: what the last run found, what is in
flight, what needs a person. What it does not show is the *work being discussed*
— the exchange between the owner and the agent that decides what happens next.

That exchange currently lives in a terminal the owner is not sitting at. The
comments feature is the only channel back, and it is a one-line box.

## Requirement 1 — The main page is the exchange

1.1. The status page SHALL present the conversation between the owner and the
   agent as its primary content: what was asked, what was done, what is
   proposed, in order, most recent first.

1.2. An entry SHALL state who wrote it. An agent's own entry is distinguishable
   from the owner's at a glance, and the distinction SHALL come from recorded
   authorship rather than from formatting convention.

1.3. The existing panels — verdict, needs-you, in-progress — SHALL remain, and
   SHALL remain above the exchange. Someone opening the page to ask "is it
   broken" must not have to read a conversation to find out.

## Requirement 2 — Writing back from the page

2.1. The owner SHALL be able to add to the exchange from the page, not only a
   short note. The input SHALL accept a paragraph.

2.2. An entry the owner adds SHALL reach the agent by the same mechanism that
   already works: the comment store plus its watcher. No second channel.

2.3. An entry SHALL be able to reference what it is about — a file, a task id,
   or a prior entry — so a reply is not orphaned from its subject.

## Requirement 3 — What is recorded, and by whom

3.1. The agent SHALL record its own side of the exchange. Nothing may claim the
   agent said something it did not.

3.2. An entry SHALL carry when it was written, and the page SHALL show that.
   A conversation with no timestamps cannot be read for sequence.

3.3. The transcript SHALL NOT be reconstructed from the terminal by scraping.
   Whatever is shown is recorded deliberately at the moment it is written.

## Requirement 4 — What this is not

4.1. This is not a chat interface to a live model. The agent writes when it has
   something to say; the page is not a prompt box with a cursor waiting.

4.2. The page SHALL NOT imply an agent is reading when none is running. The
   in-progress panel already distinguishes those states and must keep doing so.

4.3. No entry SHALL be invented to fill the page. An empty exchange says it is
   empty.

## Requirement 5 — The documents page

5.1. `/files` lists markdown and `/view` renders it. Both are unstyled relative
   to the rest of the UI and are the least usable surface in it.

5.2. The documents surface SHALL be designed rather than defaulted: a reader
   navigating specs on a phone is the case it exists for.

5.3. Design work SHALL NOT introduce a dependency. The UI is zero-dependency and
   server-rendered, and that is what makes it start instantly and work offline.

## Open questions

- Whether the exchange and the comment store are one record or two. They
  overlap; two stores that can disagree is the drift this project keeps
  reporting elsewhere.
- How much of a long agent turn is worth recording. A full transcript is noise;
  a one-line summary loses the reasoning that made the turn worth reading.
