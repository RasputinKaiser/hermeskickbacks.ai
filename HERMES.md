# Hermes Integration

This fork carries the Hermes Agent integration as first-class source under
`hermes/plugins/kickbacks`. The extension still supports VS Code, Claude Code,
and Codex; Hermes uses the Python plugin because Hermes exposes native runtime
hooks instead of a VS Code extension host.

## What This Proves

- `npm run hermes:status` proves whether the local Hermes plugin files match
  this fork.
- `npm run hermes:check` proves this fork still carries the expected Hermes
  plugin contract and installer behavior.
- `npm run hermes:test` proves the vendored plugin's local capture behavior:
  kwargs-compatible hooks, fresh cache fallback, active-span timing, view ticks,
  and threshold metrics.
- `npm run hermes:verify` runs the fork contract check, plugin tests, and
  installed-plugin file parity check in sequence.
- A live Hermes earning claim still requires a real Hermes run plus backend
  metric or earnings receipts. Setup status is not payout proof.

## Install Into Hermes

```bash
npm run hermes:install
```

The installer mirrors `hermes/plugins/kickbacks` into
`~/.hermes/plugins/kickbacks`, excluding Python caches. If a target already
exists, it creates a timestamped backup next to the target before replacing it.
Status compares missing, changed, and extra target files so stale local plugin
files cannot hide behind a green file-count check.

Useful variants:

```bash
npm run hermes:status
npm run hermes:check
npm run hermes:verify
node scripts/install-hermes-plugin.mjs --dry-run
node scripts/install-hermes-plugin.mjs --check
node scripts/install-hermes-plugin.mjs --status --json
node scripts/install-hermes-plugin.mjs --target /path/to/profile/plugins/kickbacks
```

Restart active Hermes sessions after install so the updated plugin module is
imported.

## Runtime Contract

The Hermes plugin registers these hooks:

- `pre_llm_call`
- `post_llm_call`
- `pre_tool_call`
- `post_tool_call`
- `on_session_start`
- `on_session_end`

Hook handlers intentionally accept `*args, **kwargs` because current Hermes hook
payloads are keyword-shaped. The tracker keeps an active-span counter and a
short `KICKBACKS_STOP_GRACE_MS` default of `350` milliseconds, so tight LLM/tool
handoffs do not fragment one visible work block into unbillable slivers.

If live inventory is late but `~/.kickbacks/hermes-ad.json` has a fresh signed
ad, the plugin hydrates from cache without rewriting that cache as if it were a
new backend fetch.

## Proof Boundaries

- Installed plugin: file match from this fork to `~/.hermes/plugins/kickbacks`.
- Visible runtime: real Hermes output containing Kickbacks plugin activity.
- Collection: accepted `impression_rendered`, `view_tick`, or
  `view_threshold_met` metrics.
- Earnings: `/v1/earnings` before/after movement.
- Payout settlement: payment or settlement evidence only.

Keep those separate in reports. It is very easy to accidentally call an install
marker "earning"; this repo should make that harder.
