<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/logos/kickbacks-white.svg">
  <source media="(prefers-color-scheme: light)" srcset="media/logos/kickbacks-green.svg">
  <img alt="Kickbacks" src="media/logos/kickbacks.svg" width="320">
</picture>

### Get paid while you code.

**Kickbacks** sells the little "thinking…" word inside Claude Code, Codex, and
Hermes Agent wait states — and pays **up to 50% of ad revenue back to you**, the
developer whose machine showed it.

[![Website](https://img.shields.io/badge/kickbacks.ai-00B894?style=for-the-badge&logoColor=white)](https://kickbacks.ai)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Install-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Kickbacksai.kickbacks-ai)
[![License](https://img.shields.io/badge/license-Source--Available-lightgrey?style=for-the-badge)](LICENSE)

</div>

---

## 💡 The idea

When Claude Code, Codex, or Hermes Agent is thinking, it shows a random verb or
status row — *"Discombobulating…"*, *"Baking…"*, *"Percolating…"*. Cute, but
it's prime real estate doing nothing.

Kickbacks turns that one line into a tiny, tasteful, **clickable** sponsored slot.
Advertisers bid for it in an open auction. You get **up to 50% of ad revenue**
— credited automatically, per impression and per click.

```diff
- ✶ Discombobulating… (esc to interrupt)
+ ✶ Linear — issue tracking that's actually fast ↗ (esc to interrupt)
```

No surveys. No crypto. No "watch this video." You just… keep coding, and your
balance ticks up in the status bar:

```
Kickbacks  ($0.42 today · $7.11)
```

## 🤝 How the money works

- **Advertisers buy blocks.** One block = **1,000 five-second impressions**. They set
  a price per block and an ad creative, then buy as many blocks as they want.
- **An English-ascending auction** decides whose ad shows where, and when.
- **Revenue share.** Up to 50% of ad revenue accrues to the developer whose
  editor rendered the ad. Clicks are worth **50×** an impression.
- **Real-time balance.** Today / this month / lifetime, right in your VS Code
  status bar, with a full ledger at [kickbacks.ai](https://kickbacks.ai).

## 🛑 Not for automation

Kickbacks is for real developer wait states while you code. It is not for bot
traffic, click farms, scripted earning loops, artificial idle sessions, or
automated clicking. Invalid or abusive activity may be rejected and may not be
credited or paid.

## 🎯 Where the ad shows up

Multiple local surfaces, one plugin:

| Surface | Where | Needs |
| --- | --- | --- |
| **Spinner overlay** | Claude Code VS Code panel | A compatible extension build |
| **Thinking-shimmer** | Codex VS Code panel | A compatible extension build |
| **Status-bar line** | Claude Code terminal CLI | Any Claude Code version |
| **Spinner verb** | Claude Code terminal CLI | Claude Code **2.1.143+** |
| **Runtime hooks** | Hermes Agent plugin runtime | `npm run hermes:install` |
| **TUI status row** | Hermes Ink TUI | `npm run hermes:tui-links` |
| **Classic CLI spinner** | Hermes `--cli` prompt_toolkit runtime | `npm run hermes:cli-links` |
| **Slash command link** | Hermes `/kickbacks-click` | Installed Hermes plugin |

VS Code surfaces work on local, Remote-SSH, devcontainers, and code-server.
Older CLIs just keep their stock verbs — nothing breaks.

This fork carries the Hermes Agent plugin too: clickable sponsored text in the
Hermes TUI/classic CLI and a `/kickbacks-click` command for the current ad. See
[HERMES.md](HERMES.md) for Hermes install, update notes, and proof-layer
boundaries.

## 🧠 Hermes Agent

Hermes support lives under `hermes/plugins/kickbacks` and is installed into your
local Hermes profile:

```bash
npm run hermes:install
```

- `/kickbacks` shows Hermes plugin status, earnings, and the current ad.
- `/kickbacks-click` records a plugin-owned click metric and returns the current
  ad as a safe Markdown link.
- Hermes TUI and classic CLI links use the current ad's safe `http(s)` URL.
- `npm run hermes:update-safe` helps keep the local Hermes install current after
  upstream Hermes updates.

Backend metric acceptance, earnings movement, and payout settlement are separate
proof layers; [HERMES.md](HERMES.md) keeps those boundaries explicit.

## 🚀 Install

1. Search **Kickbacks** in the VS Code Marketplace and install.
2. Click **Kickbacks: Sign in** in the status bar.
3. Authenticate with Google.
4. Keep coding. Earnings start automatically.

→ **[Get it on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Kickbacksai.kickbacks-ai)**

## 📣 Want to advertise?

You're buying attention from the most technical audience on earth, in the calmest
possible format — a single line, while they wait. Set your bid, drop in a creative,
and you're live.

→ **[Buy inventory at kickbacks.ai](https://kickbacks.ai)**

## 🧱 What's in this repo

This is a **public, read-only mirror** of the Kickbacks VS Code extension — the
client that renders the ads and tracks impressions. It's published for
transparency: you can read exactly what runs on your machine.

```
src/
  adapters/        per-tool injection (claude-code, codex, claude-cli, codex-cli)
  activation/      lifecycle: ad rotation, self-update, status bar, injection
  auth/            sign-in + OS-keychain-sealed token vault
  metrics/         impression / view-threshold / click telemetry (idempotent)
  viewTracking/    "was it actually on screen long enough?" timer
  killswitch/      server-controlled global off-switch
hermes/
  plugins/         Hermes Agent plugin source and tests
media/             logos + icons
test/              the vitest suite that guards editor safety
```

The backend, advertiser portal, auction engine, and marketing site live in a
separate private repository.

### Build it yourself

```bash
npm install
npm run build       # esbuild → dist/
npm test            # vitest — the editor-safety net
npm run hermes:test # Python tests for the Hermes plugin
npm run hermes:status
npm run hermes:check
npm run hermes:verify
npm run hermes:install
npm run package     # produce the .vsix
```

## 📜 License

**Proprietary and source-available — _not_ open source.** © 2026 ShiftKeys, Inc.
All rights reserved. You may read this code; you may **not** use, copy, modify,
distribute, or commercialize it without a written license. See [LICENSE](LICENSE).
Commercial inquiries: **support@kickbacks.ai**.

<div align="center">
<br>
<sub>Made with caffeine by <a href="https://kickbacks.ai">ShiftKeys</a> · up to half the ad revenue is yours.</sub>
</div>
