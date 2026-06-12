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
Add `--receipt <path>` to any install/status/check command to write the same
comparison as JSON for automation logs. Receipts include deterministic
`sourceDigest` and `targetDigest` values over the copied file set; matching
digests prove source/target file parity for the installer scope.
Receipts also include `proofLayer: "hermes-plugin-file-parity"` and a
`proofBoundary` that explicitly says they are not runtime, metric, earnings, or
payout proof.
For destructive install operations, source and target must be different
`kickbacks` directories and may not be nested inside each other.

Useful command forms:

```bash
npm run hermes:status
npm run hermes:check
npm run hermes:verify
npm run hermes:full-verify
npm run hermes:tui-links
npm run hermes:tui-verify
npm run upload:audit-public
node scripts/install-hermes-plugin.mjs --dry-run
node scripts/install-hermes-plugin.mjs --check
node scripts/install-hermes-plugin.mjs --status --json
node scripts/install-hermes-plugin.mjs --status --receipt artifacts/hermes-plugin-status.json
node scripts/install-hermes-plugin.mjs --target /path/to/profile/plugins/kickbacks
```

Restart active Hermes sessions after install so the updated plugin module is
imported.

`npm run hermes:tui-links` patches the local Hermes Ink TUI so the busy
status-row sponsored phrase is read from `~/.kickbacks/hermes-ad.json` and
rendered as a clickable Ink link using the ad's `click_url`. This is live TUI
source/build integration; it is separate from backend metric acceptance,
earnings movement, payout settlement, and a human-recorded click proof.
`npm run hermes:tui-verify` checks that the local Hermes TUI source and built
bundle still contain the status-row link path, then runs the focused TUI tests
and typecheck.
`npm run upload:audit-public` fetches `origin/main` and audits the public branch,
remote paths/refs, repository metadata, and GitHub code search for blocked
identity strings. It is intentionally separate from `hermes:verify` because it
uses network and GitHub CLI state.
`npm run hermes:full-verify` runs local plugin verification, local Hermes TUI
clickable-ad verification, and the public upload audit in sequence. It is the
strongest repeatable proof command, but it depends on the local Hermes TUI and
network/GitHub CLI state.

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
- Installer receipt: machine-readable file-parity evidence for automation,
  including deterministic source and target digests.
- Visible runtime: real Hermes output containing Kickbacks plugin activity.
- Collection: accepted `impression_rendered`, `view_tick`, or
  `view_threshold_met` metrics.
- Earnings: `/v1/earnings` before/after movement.
- Payout settlement: payment or settlement evidence only.

Keep those separate in reports. It is very easy to accidentally call an install
marker "earning"; this repo should make that harder.
