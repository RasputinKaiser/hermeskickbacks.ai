---
name: kickbacks
description: "Use when working on Kickbacks revenue, Hermes CLI ad capture, payout proof, backend auth, or proof-layer separation."
---

# Kickbacks

Use this skill for Kickbacks revenue work in the local Kickbacks workspace:

```bash
$KICKBACKS_WORKSPACE
```

## Start With Proof Layers

Keep these claims separate:

- Backend auth: token, portfolio, consent, `/v1/earnings`.
- Visible runtime: real `hermes chat --cli` output and `[kickbacks]` metric lines.
- Collection proof: `impression_rendered`, `view_tick`, `view_threshold_met`, and earnings before/after.
- Hermes.app proof: preload or app marker only.
- Codex CLI proof: launcher wrapper and native terminal proof are separate.

## Primary Revenue Command

Run useful Hermes CLI work through the money doctor:

```bash
node "$KICKBACKS_WORKSPACE/kickbacks/scripts/kickbacks-hermes-cli-money-doctor.mjs" \
  --provider nous \
  --model stepfun/step-3.7-flash:free \
  --maxTurns 1 \
  --hermesTimeoutMs 420000 \
  --prompt "<real methods/tooling/research task>"
```

Prefer methods, tooling, measurement, and repo-improvement prompts over sales-material prompts. Aim for useful 45-90 second work blocks that clear at least 15000ms visible ad time, with 30000ms as the preferred target.

## After Each Revenue Block

Run:

```bash
node "$KICKBACKS_WORKSPACE/kickbacks/scripts/kickbacks-payout-anomaly.mjs"
node "$KICKBACKS_WORKSPACE/money-earning-update-from-tracker.mjs" \
  --state "$KICKBACKS_WORKSPACE/state.yaml" \
  --metrics "$KICKBACKS_WORKSPACE/money-earning-metrics-log.csv" \
  --artifacts 5 \
  --opportunities 5
```

## Key Files

- `$KICKBACKS_WORKSPACE/state.yaml`
- `$KICKBACKS_WORKSPACE/kickbacks-hermes-cli-money-doctor.md`
- `$KICKBACKS_WORKSPACE/kickbacks-payout-log.md`
- `$KICKBACKS_WORKSPACE/kickbacks-payout-anomaly.md`
- `$KICKBACKS_WORKSPACE/kickbacks-methods-tooling-research.md`

## Report Honestly

- `view_threshold_met status=200` proves metric acceptance for that run, not payout settlement.
- Lifetime and today counters can diverge; report both.
- If earnings do not move, say so even when runtime metrics passed.
- Do not use setup checks, wrapper markers, or app preload markers as billing proof.
