# 0039 — The landing page: design

Resolves the three questions the requirements left open, and fixes the visual
direction before any markup is written.

## The source lives in `site/`, deployed by an action

Not `docs/` published directly.

Pages publishing `docs/` would put marketing copy in the same directory as the
specs, the protocol notes and the analyzer guides, and every tool that walks
`docs/` — the review server's documents page, the spec workflow check — would
have to learn to skip it. A separate `site/` costs one workflow file and keeps
both directories about one thing.

`site/` holds `index.html`, `style.css`, `player.js`, `tracks.json`, the three
audio files and the images. There is no build step (R1.1): the workflow uploads the
directory as-is.

## Three tracks, picked at random per load

`site/tracks.json` holds all three with their own timing maps. One is chosen at
random on each load and the choice is not remembered, so a returning visitor
hears a different one and all three get heard over time.

The audio files themselves stay cacheable. It is the *choice* that is not
cached, not the bytes — a visitor who lands on the same track twice should hear
it start instantly rather than download four megabytes again.

Only the chosen track is fetched, and only when play is pressed (R2.7).

## Verse timing is anchored, and its precision is stated

Each track carries `cues`: a verse's `start` and `end` in seconds, and the lines
sung in it. Line timing is derived — each verse's lines are laid across 86% of
the verse, apportioned by length because a longer line takes longer to say, with
a floor so no line flashes past, and the last line holds through the verse's
instrumental tail rather than the ticker going blank.

That makes line timing exact at every verse boundary and approximate between
them, which is the honest description of it (R2.5). The alternative, per-line
timestamps for three tracks, is a lot of hand-authoring to correct an error the
re-sync at each verse already bounds.

Deriving timings outright would need audio analysis, which R1.1 forbids for a
page that shows a line of text. The cost is that re-rendering a track
invalidates its map, and that cost is paid by `player.js` comparing the loaded
audio's duration against the declared `seconds` and warning to the console when
they disagree — a stale map announces itself instead of silently pointing at the
wrong line.

## The pulse reads the signal rather than guessing the tempo

The ticker moves with the music by reading the playing audio through an
`AnalyserNode`: the lowest frequency bins are the kick and bass, and their level
relative to a decaying floor and ceiling is published as a `--beat` custom
property that CSS scales and glows from.

Beat *positions* cannot be detected reliably without an analysis library, and a
hard-coded BPM would drift and would be a guess presented as a fact. Reading the
signal is neither: it responds to the actual hit. A fixed divisor was tried
first and saturated — on a mastered track every frame read as maximum and
nothing pulsed — which is why the floor and ceiling are tracked.

Where `AudioContext` is unavailable, or the visitor prefers reduced motion, the
ticker shows the line and does not pulse.

## The lyric sits beside the argument, it is not the argument

Each section carries prose that makes the point properly, and the matching verse
quoted alongside it. They are the same claim at two densities.

Making the verse *be* the copy would be the cheaper page and the worse one:
"it ain't defiance, it's dilution" is a line you remember after you understand
the point, not a line that teaches it.

## Visual direction

### Where it comes from

The track is golden-era boom bap and the tool issues verdicts. The two worlds
share one artifact: **a numbered list of short entries, each with a code and a
timing**. A tracklist and a findings list are the same object. That is the
structural device the page is built on, and it is legitimate numbering — the
content genuinely is a sequence, and the order carries the argument.

The reference is the cassette j-card: block display lettering, a printed
tracklist with times, a mono typewriter face for the small print.

### Colour

| token | hex | what it is |
|---|---|---|
| `--ink` | `#16130F` | warm near-black, all body text |
| `--shell` | `#C8BCA8` | tape-shell grey-brown, page ground |
| `--card` | `#EDE7DB` | j-card stock, content surfaces |
| `--rec` | `#C8342B` | record-button red: play control, failing states |
| `--pass` | `#3F6B57` | a dull, unconvincing green |
| `--rule` | `#2D4A7C` | ink blue: links, section rules, the tracklist spine |

`--pass` is the deliberate choice. The page's whole thesis is that a green
terminal is not evidence, so the green on this page is muted and slightly
disappointing, while the red is the loudest colour on the page. A visitor should
feel the hierarchy before they read the sentence that states it. A bright
success green would be the page arguing against itself in CSS.

Two accents rather than one, because a dark page with a single bright accent is
the house style of every developer tool shipped this year, and this one should
not be mistaken for them.

### Type

- **Display:** a heavy condensed grotesque, tight tracking, set large — the
  block-letter look of a 12" sleeve. Used for the hero line and section numbers
  only.
- **Body:** a plain grotesque at a generous size. The page is read by people who
  do not read documentation for a living.
- **Mono:** every piece of tool output, every rule id, every timing. Tool output
  is quoted material and is set as such.

System stacks, self-hosted or omitted — R1.2 forbids a font CDN. Where a
characterful display face is not available locally the fallback is the condensed
system grotesque at heavy weight, which holds the shape.

### Layout

A left spine and a reading column, with the player pinned to the bottom.

```
┌──────────────────────────────────────────────────────────┐
│  CHECK YOUR VIBE                          [ install ▸ ]  │
│                                                          │
│   $ tsc --noEmit                                         │
│   ✓ no errors                          ← dull green      │
│                                                          │
│   GREEN DON'T MEAN                                       │
│   IT'S RIGHT.                          ← display, huge   │
│                                                          │
│   Your agent said it was done. It says that either way.  │
├────────┬─────────────────────────────────────────────────┤
│ 01     │  It sounds the same when it's wrong             │
│ 02     │  ┌───────────────────────────────────────────┐  │
│ 03     │  │ prose making the point                    │  │
│ 04     │  ├───────────────────────────────────────────┤  │
│ 05     │  │ ▌the verse, quoted, mono, ink blue rule   │  │
│ 06     │  └───────────────────────────────────────────┘  │
│ 07     │                                                 │
│contents│  real cyv output, mono, copyable                 │
├────────┴─────────────────────────────────────────────────┤
│ ▶ ⏭  Check Your Vibe  90s boom bap                       │
│      it ain't dilution, it's arithmetic, not power  ←tick│
│      ────────────●───────────────────────────  2:14/4:33 │
└──────────────────────────────────────────────────────────┘
```

The left rail is a contents list and nothing else. The signature element is the
ticker: the line being sung, moving on the record's own low end. It is the one
place the page spends boldness; everything around it is quiet.

### The hero is an artifact, not a headline

The first thing on the page is a real terminal block reporting a clean pass in
the dull green — and directly beneath it, in display type, what that pass is
worth. No gradient, no logo wall, no metric. The most characteristic object in
this product's world is a passing check that is not evidence, so the page opens
with one.

## The player is an ordinary media player

Play and pause, a scrub bar, elapsed and total time, and a next-track control.
`<audio preload="none">` so nothing is fetched until play is pressed.

An earlier draft made the transport double as page navigation: a segmented strip
where each segment was a verse, and clicking one seeked the track and scrolled
the page. It was built and rejected on sight — someone who presses play on a
landing page wants to hear a song, and a transport that is secretly a table of
contents is a control that does not do what it looks like it does. The contents
list is a plain list of links in the left rail, where a contents list belongs.

**Not autoplay** (R2.3). Playback begins on a press.

**Scrubbing before the audio loads.** With `preload="none"` there is no duration
until the first play, and a `currentTime` set before metadata exists is
discarded. A seek made in that window is held and applied on `loadedmetadata`.

**Keyboard** (R5.2): every control is a real button in tab order with a visible
focus ring. Space toggles play only when the player has focus — a page that
steals space from a scrolling reader is broken — and is left alone on the scrub
input, which uses arrow keys.

**Without JavaScript** (R1.3) the `<noscript>` block renders the audio element
with native controls, the contents list is ordinary anchors, and each section
keeps the verse quote written into its markup.

**On a phone** (R5.1) the subtitle and next control drop out and the ticker
sets smaller. Body content carries bottom padding equal to the bar's height so
the bar never covers the last line of a section.

## Imagery

Three loops, each carrying an argument (R3.4), authored as SVG with SMIL or CSS
animation so they are text in the repository and honour reduced motion:

1. **Decay.** A rules file's instruction, obeyed at turn 1, still obeyed at turn
   40, gone at turn 400 — with no error printed at any point. This is the
   argument the prose cannot make as fast.
2. **The shortcut.** A finding raised, a type widened, the finding gone, and the
   defect still present one layer down. Ends on the not-fixes list.
3. **Distribution.** Four lanes, one saturating, work moving to the next.

The existing `docs/media/*.svg` are diagrams for documentation and are reused
where they fit rather than redrawn.

## What the page must not claim

R3.2 is the constraint that has already been violated once in the README. The
page states what the tool does today. The Unreal module, rule packs not yet
shipped, and any executor lane not implemented are absent — not written in the
future tense, absent.

Every outbound link is checked by the same link checker CI already runs (R4.3).

## Publishing

`.github/workflows/pages.yml`, on push to `main` under `site/**`, and manually.

**Pages from a private repository requires a paid plan** — Pro on a personal
account, Team or Enterprise on an organisation. On a free account Pages
publishes only from public repositories, and the deploy step fails with a
permissions error that reads like a misconfiguration rather than a billing
state.

So the workflow builds and uploads the artifact unconditionally, proving the
site is publishable, and skips deployment while the repository is private with
the reason written to the run summary (R6.2). It does not fail. When the
repository becomes public the same workflow deploys unedited.

The nuance worth writing down, because it is the one people get wrong: paying
for Pro lets you publish *from* a private repository, but the published site is
still public. Serving a Pages site to a restricted audience is an Enterprise
Cloud feature. A paid plan buys privacy for the source, not for the page.

Which leaves three ways to get the page onto the internet:

| | source stays private | site is public | costs |
|---|---|---|---|
| make this repo public | no | yes | nothing |
| GitHub Pro or Team | yes | yes | a subscription |
| push `site/` to a separate public repo | yes | yes | nothing |

The third is the one that does not need a decision on T5010 or a subscription:
a public repository holding only the built site, pushed by an action from this
one. The page goes out; the tool does not. It is not wired up, because which of
the three to take is not a design decision.

**Before uploading, the workflow checks the site is complete**: the four source
files exist, and every track named in `tracks.json` is actually present in
`site/`. A missing audio file is a 404 that a visitor experiences as a play
button doing nothing, and nothing else in the pipeline would catch it.

## Not doing

- **A blog, a changelog, or a docs site.** The documentation is in the
  repository and is linked. Rehosting it is a second copy to keep true.
- **Analytics.** R1.2 forbids the third-party request, and the number would not
  change a decision.
- **A newsletter capture.** There is nothing to send.
