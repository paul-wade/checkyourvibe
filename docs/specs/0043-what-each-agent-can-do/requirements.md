# 0043 — What each agent can actually do

**Status:** draft
**Created:** 2026-09-01
**Depends on:** 0036

## Introduction

Spec 0036's Requirement 9 asked cyv to discover, for each agent it can invoke,
whether the program is installed, whether it authenticates, which models it
offers and which of them are free under the plan. Two tasks (T36011, T36012)
carried it and the owner read them as a story of their own: it is a discovery
surface, not a survival mechanism, and its second attempt already wanted a
test-parse fixture outside its declared scope. It moves here with that scope
widened, and 0036 closes without it.

The requirements are 0036 R9.1 through R9.8, unchanged, and are restated here
so this spec can be cited by number.

## Requirement 1 — Discovery

1.1. cyv SHALL discover, for each agent it can invoke: whether the program is on
   `PATH`, whether an invocation authenticates, and, where the CLI can report
   it, which models it offers.

1.2. Presence on `PATH` SHALL NOT be reported as availability. A CLI that is
   installed and cannot authenticate is not capacity.

1.3. WHERE a CLI reports its own model catalogue, cyv SHALL read it and SHALL
   report a lane declaring a model that catalogue does not contain.

1.4. WHERE a CLI reports what a model costs, cyv SHALL surface which models are
   free under the plan and which are billed per use, and SHALL report a lane
   declaring `billing.kind: subscription` whose models the vendor prices per
   token. This is a published price list, not a quota reading (0011 R7.1).

1.5. Discovery SHALL NOT rewrite the configuration.

1.6. Every discovered fact SHALL carry when it was discovered.

1.7. A discovery that cannot be performed SHALL be reported as not determined,
   and SHALL NOT fall back to a list of model names shipped inside cyv.

## Requirement 2 — Scope

2.1. The task that implements the catalogue readers SHALL own a fixture
   directory for recorded vendor output, so that parsing is tested against
   what a CLI printed rather than against a guess, and so the fixture does not
   fall outside the declared scope as it did under 0036.
