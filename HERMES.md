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
npm run hermes:cli-links
npm run hermes:cli-verify
npm run hermes:patch-audit
npm run hermes:proof -- --receipt /tmp/hermes-local-proof.json
npm run hermes:update-safe
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
rendered as both an Ink link and a direct TUI click target using the ad's
`click_url`. The patch also binds the whole status-row ad text range so clicks
that hit the row container, rather than the nested link node, still open the ad.
This is live TUI source/build integration; it is separate from backend metric
acceptance, earnings movement, payout settlement, and a human-recorded click
proof.
`npm run hermes:tui-verify` checks that the local Hermes TUI source and built
bundle still contain the status-row link and direct click paths, then runs the
focused TUI tests and typecheck.
Add `-- --receipt <path>` to archive a machine-readable local TUI click-layer
receipt after those checks pass, for example:

```bash
npm run hermes:tui-verify -- --receipt /tmp/hermes-tui-click-proof.json
```

After commit `9f391d6ee3ada9fb7148e1ac8be6143ed91fd693`, a live Hermes TUI
session opened a status-row ad phrase from the running `hermes` command. Treat
that as local TUI click proof only; backend metric acceptance, earnings
movement, and payout settlement remain separate proof layers.

The plugin also exposes `/kickbacks-click`. That command records a local
`click` metric for the current ad through the Hermes plugin tracker and returns
the ad as a safe Markdown link. This proves the plugin-owned slash-command
click path and event-shape tests; TUI/classic CLI direct hyperlink click
telemetry, backend metric acceptance, earnings movement, and payout settlement
remain separate proof layers.

`npm run hermes:cli-links` patches the local Hermes classic `--cli`
prompt_toolkit spinner so the same sponsored phrase is wrapped in an OSC 8
terminal hyperlink when the cached ad has a safe `http(s)` `click_url`.
`npm run hermes:cli-verify` checks the active `hermes` command path, confirms
the classic CLI link markers are present, runs the focused Hermes Kickbacks
tests, and reports whether the installed Hermes repo is behind `origin/main`.
That update status is maintenance context only, not click or earnings proof.
After `hermes update`, rerun:

```bash
npm run hermes:tui-links
npm run hermes:cli-links
npm run hermes:full-verify
```

For the full update cycle, prefer:

```bash
npm run hermes:update-safe
```

It snapshots the local Hermes checkout into `.codex/hermes-update-backups`,
stashes the current local Hermes patch set, runs `hermes update`, reapplies the
TUI and classic CLI link patches, and runs `hermes:full-verify`. Use
`-- --skip-update` to reapply and verify after an update already happened, or
`-- --skip-verify` when you only need the reapply step.

`npm run hermes:patch-audit` verifies the installed Hermes checkout is at
`origin/main` and that its local dirty file set is exactly the expected
Kickbacks TUI/classic CLI patch surface. It should pass after reapplying the
patches; extra dirty Hermes files are treated as drift.

`npm run hermes:proof -- --receipt <path>` writes one combined local proof
receipt covering installed plugin parity, plugin behavior tests, TUI clickable
links, classic CLI clickable links, and local patch-scope audit. It is a compact
handoff artifact for local proof layers, not backend acceptance, earnings, or
payout settlement proof.

`npm run upload:audit-public` fetches `origin/main` and audits the public branch,
remote paths/refs, repository metadata, and GitHub code search for blocked
identity strings. It is intentionally separate from `hermes:verify` because it
uses network and GitHub CLI state.
`npm run hermes:full-verify` runs local plugin verification, local Hermes TUI
clickable-ad verification, local Hermes classic CLI clickable-ad verification,
local Hermes patch-scope audit, the combined local proof receipt, and the public
upload audit in sequence. It is the strongest repeatable proof command, but it
depends on the local Hermes install and network/GitHub CLI state.

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
