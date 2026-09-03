# 0039 — The landing page

**Status:** draft
**Created:** 2026-08-31

There is nowhere to send someone. The README is written for a developer who has
already decided to read it; the argument for the tool is spread across four
documents and a song, and none of them is a link you can put in a message.

The audience is the one named in the song: someone shipping software with an
agent who has never been told that a green terminal is not evidence. They are
not reading `docs/adoption.md`. They will give the page thirty seconds.

## Requirement 1 — The site is static and dependency-free

1.1. The site SHALL be hand-written HTML, CSS and JavaScript served as files,
   with no build step, no framework, and no package dependency. This is the same
   constraint `tools/review/` holds and for the same reason: a page that needs a
   toolchain to render is a page that stops rendering.

1.2. The site SHALL make no network request to a third party. No font CDN, no
   analytics, no embed. Every asset is served from the site's own origin.

1.3. The site SHALL be readable with JavaScript disabled and with CSS absent.
   The player and any motion are enhancements over a page that already works.

## Requirement 2 — The songs

Three tracks argue the product in three genres. They are the pitch, not
decoration.

2.1. The player SHALL be an ordinary media player — play and pause, a scrub bar,
   elapsed and total time, and a control to move to the next track. It SHALL
   NOT repurpose the transport as page navigation.

2.2. A track SHALL be chosen at random on each page load, so a returning visitor
   hears a different one and all three get heard over time. The choice SHALL
   NOT be remembered between loads.

2.3. Playback SHALL NOT start on its own. It begins because a person asked.

2.4. WHERE a track has a lyric map, the line currently being sung SHALL be shown
   and SHALL advance with the audio. WHERE it has none, the ticker SHALL be
   absent rather than blank.

2.5. Lyric timing SHALL be honest about its precision: anchored per verse and
   apportioned within it. It SHALL NOT be presented as frame-accurate.

2.6. WHERE the ticker animates in time with the music, that animation SHALL be
   driven by the playing audio's own signal rather than by an assumed tempo,
   and SHALL be absent rather than faked when the signal cannot be read.

2.7. The audio SHALL NOT be fetched until playback is requested. Only the chosen
   track is ever fetched.

## Requirement 3 — What the page has to land in thirty seconds

3.1. The first screen SHALL state the thesis — a passing terminal is not
   evidence — without requiring a scroll, and SHALL NOT open with a feature
   list, a logo wall, or a metric nobody can verify.

3.2. Every claim on the page SHALL be one the tool actually does today. No
   roadmap item is written in the present tense. This is the same rule the
   README is now held to.

3.3. The page SHALL show the tool's real output — a finding, its not-fixes, a
   withheld semantic result — as text, not as a screenshot. Real output is the
   evidence, and a screenshot cannot be copied, searched, or read aloud.

3.4. Motion and imagery SHALL carry an argument. A loop showing a rules file
   being obeyed and then quietly ignored is worth its bytes; a decorative
   animation is not.

## Requirement 4 — Getting started is on the page

4.1. The install command SHALL be visible without a scroll to the footer, and
   SHALL be copyable in one action.

4.2. The page SHALL state the cost model plainly: it runs on the agent
   subscription already paid for, and takes no API key.

4.3. Every path off the page — repository, getting started, writing an analyzer
   — SHALL be a real link to a document that exists.

## Requirement 5 — It works on the device it will be opened on

5.1. The page SHALL be readable on a phone, including the player, which SHALL
   NOT obscure content it overlays.

5.2. The page SHALL respect `prefers-reduced-motion`, SHALL keep keyboard focus
   visible, and SHALL be operable by keyboard alone, including the player.

5.3. The page SHALL respect `prefers-color-scheme` or commit to one scheme
   deliberately; it SHALL NOT render illegibly in either.

## Requirement 6 — Publishing does not depend on a decision not yet made

6.1. The site SHALL be buildable and reviewable locally before the repository is
   public, so publication is a switch and not a project.

6.2. WHERE the repository is private, the workflow SHALL NOT fail. Pages from a
   private repository requires a paid plan; the deploy step is skipped with the
   reason stated rather than erroring.

6.3. The site's source SHALL live in the repository it describes.

## Open questions

- Where the site's source lives: `docs/` published by Pages directly, or a
  separate `site/` directory deployed by an action. The first is fewer moving
  parts; the second keeps documentation and marketing from sharing a directory.
- How verse timing is known. Hand-authored timestamps are exact and go stale if
  the track is re-rendered; deriving them is not possible without a dependency.
- Whether the lyrics are shown in full on the page, and if so whether they are
  the section copy itself or a separate panel.
