# 0039 — The landing page: tasks

**Status:** open
Requirements in `requirements.md`, decisions in `design.md`.

The site is hand-written HTML, CSS and JavaScript in `site/`, with no build step
and no dependency (R1.1). Nothing here may add one.

## Open

- [x] **T39001** The site skeleton and the visual system
  `site/index.html` and `site/style.css`. Built once as a cream page with muted
  type, which was one of the three looks AI-generated pages cluster around, and
  rebuilt as a Blue Note sleeve: the terminal output as the album photograph
  with a wide-tracked photo credit, the thesis stacked beside it in display caps
  bleeding off the right edge (R3.1), sections as paper inserts numbered as a
  tracklist. Each section carries prose and the matching verse quoted alongside
  (design: "the lyric sits beside the argument"). No third-party request, no
  font CDN (R1.2).
  Every claim is one the tool does today (R3.2) — the Unreal module and
  unshipped packs are absent, not written in the future tense.
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=site/index.html,site/style.css_

- [x] **T39003** The player
  `site/player.js`: an ordinary media player — play, next, scrub, time (R2.1) —
  with `<audio preload="none">` (R2.5) and no autoplay (R2.3). One of the three
  tracks is picked at random per load and the choice is not remembered (R2.2).
  A lyric ticker shows the line being sung where the track has a map, and is
  absent where it has none (R2.4). The ticker pulses on the audio's own
  low-frequency energy through an `AnalyserNode` rather than a guessed tempo
  (R2.6). Warns to the console when the loaded audio's duration disagrees with
  `tracks.json`, so a stale map announces itself. Degrades to a native
  `controls` element with no script (R1.3).
  A first draft made the transport double as page navigation, each segment a
  verse that seeked and scrolled. Rejected on sight: a control that is secretly
  a table of contents does not do what it looks like it does.
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=site/player.js_

- [x] **T39004** The audio asset, and the page's weight
  Three tracks are in `site/` (15.5 MB together). Measured in the browser: a
  visitor who never presses play makes **zero** requests for any `.mp3` and
  transfers **43 KB** of CSS, JavaScript and the track map, plus the document.
  Only the randomly chosen track is ever fetched, and only on play.
  _Exec: executor=local kind=mechanical gates=self-check files=site/check-your-vibe.mp3_

- [ ] **T39005** The three argument loops
  SVG with CSS animation, authored as text, honouring `prefers-reduced-motion`
  (R5.2): the decay of a rules file across turns with no error printed; a
  finding suppressed by widening a type while the defect stays; work moving off
  a saturated lane. Reuse `docs/media/*.svg` where they already fit rather than
  redrawing (R3.4).
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=site/media/decay.svg,site/media/shortcut.svg,site/media/lanes.svg_

- [ ] **T39006** Real output on the page, not a screenshot
  Run the tool and paste its actual output — one finding with its not-fixes, and
  one semantic result withheld with the reason — as copyable text (R3.3). The
  install command sits above the fold and copies in one action (R4.1), beside
  the plain statement that it runs on the subscription already paid for and
  takes no API key (R4.2).
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=site/index.html_

- [x] **T39007** Publish without depending on the visibility decision
  `.github/workflows/pages.yml`, on push to `main` under `site/**` and on
  manual dispatch. Builds and uploads the artifact always; skips deployment with
  the reason in the step summary while the repository is private, because Pages
  from a private repository requires a paid plan (R6.2). It does not fail. When
  the repository becomes public the same workflow deploys unedited.
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=.github/workflows/pages.yml_

- [ ] **T39008** Check the page in a browser before calling it done
  Load it, press play, confirm the spine tracks the verses, seek from a spine
  entry, tab through the player, load it at phone width, and load it with
  JavaScript disabled. Confirm every outbound link resolves (R4.3).
  This exists because the recurring defect on this project is work that passes
  its tests and does not work: the empty SVGs, the save button that could never
  fire, the gate that reported a pass over no files.
  _Exec: executor=local kind=judgment gates=self-check files=site/_

## Deferred, with the reason

- **T39002, verse timings by listening.** The map in `tracks.json` is
  apportioned from line counts, so the ticker drifts within a verse and
  re-syncs at each boundary. Correcting it needs anchors a person supplies by
  listening: deriving them was attempted from vocal-band energy against the
  full mix, and the tracks carry vocals almost throughout, so the measurement
  does not separate verses from instrumentals. There is also a ceiling that
  anchors would not move — 88 lyric lines over 4:33 is 3.11 seconds a line
  while every line is shown. Deferred by the owner; the ticker stays as it is.

- **A custom domain.** A DNS decision, and `github.io` is not the thing
  stopping anyone adopting this.
- **A blog, changelog or hosted docs.** The documentation is in the repository
  and is linked; a second copy is a second thing to keep true.
- **Analytics.** R1.2 forbids the third-party request, and the number would not
  change a decision.
