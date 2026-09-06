# 0047 — Stitch Dashboard Workbench

**Status:** active  
**Created:** 2026-09-05  
**Depends on:** 0040  

## Introduction

Spec 0040 established the four-region informational hierarchy for the `cyv dashboard`: **needs you**, **in motion**, **lanes**, and **exchange**. 

This spec incorporates the production-ready UI design templates developed under `.cyv-review/designs/stitch-17590787663427686906/` into `@checkyourvibe/core`. It transforms the existing text-heavy server-rendered dashboard into a desktop workbench and responsive mobile triage deck while preserving zero-runtime-dependency server-side HTML rendering.

## Requirement 1 — Responsive Dual-Layout Architecture

1.1. The dashboard SHALL render a unified desktop workbench on viewports $\ge 1024\text{px}$ (`desktop-workbench.html` CSS grid) and a phone-first triage deck on viewports $< 1024\text{px}$ (`needs-you-triage-deck.html` / `glance-status-hub.html`).

1.2. The rendering engine SHALL remain 100% server-side HTML/CSS with zero external client-side JavaScript frameworks.

1.3. State updates SHALL refresh telemetry and panels using lightweight server-sent events or polling without clearing half-typed text in form inputs.

## Requirement 2 — Agent Lanes & Capacity Panel

2.1. The **Lanes** panel SHALL display all configured agent lanes (`antigravity-cli`, `devin-cli`, `claude-code-cli`), their current state (`FREE`, `RUNNING`, `COOLING_DOWN`, `RESERVED`), and billing tier model annotations.

2.2. The panel SHALL display unmapped agent CLI binaries discovered in the host system `$PATH` (e.g. `codex`, `gemini`) with an actionable link/button to register them.

## Requirement 3 — Parallel Wave Pipeline

3.1. The **In Motion** region SHALL render tasks grouped into execution waves derived from `cyv plan`.

3.2. Tasks in the current runnable wave SHALL display concurrency tags (`WAVE 1 - CAN RUN CONCURRENTLY`) and status badges (`Ready`, `Needs Judgment`).

3.3. Blocked downstream tasks SHALL display the explicit dependency task ID blocking execution (`waits on T36011`).

## Requirement 4 — Needs You Triage & Exchange Deck

4.1. Tasks or notes requiring human judgment SHALL display structured problem summaries, validation rule checklists, and primary action buttons (`Approve & Run`, `Edit Prompt`, `Mark Addressed`).

4.2. Unread owner-agent notes SHALL display asynchronous message threads with quick response triggers (`Tell The Agent`).

## Requirement 5 — Live Diff & Execution History

5.1. The dashboard SHALL render working tree diff summaries (`+N / -M across K files`) with an expandable inline diff view.

5.2. The **Recent Executions** log SHALL list recent dispatches with duration timers and color-coded status badges (`Pass 1.2s`, `Gates Failed`, `out-of-scope-write`).
