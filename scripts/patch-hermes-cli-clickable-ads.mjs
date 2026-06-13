#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME || homedir();
const agentRoot = process.env.HERMES_AGENT_ROOT || join(home, ".hermes", "hermes-agent");
const cliFile = join(agentRoot, "cli.py");
const commandsFile = join(agentRoot, "hermes_cli", "commands.py");
const kickbacksFile = join(agentRoot, "hermes_cli", "kickbacks.py");
const testFile = join(agentRoot, "tests", "hermes_cli", "test_kickbacks.py");

if (!existsSync(cliFile)) {
  console.error(`Hermes CLI file not found: ${cliFile}`);
  process.exit(1);
}

if (!existsSync(commandsFile)) {
  console.error(`Hermes commands file not found: ${commandsFile}`);
  process.exit(1);
}

if (!existsSync(kickbacksFile)) {
  mkdirSync(join(agentRoot, "hermes_cli"), { recursive: true });
  writeFileSync(kickbacksFile, kickbacksHelperTemplate(), "utf8");
}

if (!existsSync(testFile)) {
  mkdirSync(join(agentRoot, "tests", "hermes_cli"), { recursive: true });
  writeFileSync(testFile, kickbacksTestTemplate(), "utf8");
}

patchFile(kickbacksFile, (src) => {
  let out = src;

  out = insertAfterOnce(out, "from typing import Any, Iterable", "from urllib.parse import urlparse");

  out = insertAfterOnce(
    out,
    "def _clean_text(value: Any, *, max_length: int = 0) -> str:",
    ""
  );

  out = insertAfterOnce(
    out,
    [
      "    if max_length and len(text) > max_length:",
      "        return text[: max(0, max_length - 1)].rstrip() + \"...\"",
      "    return text",
    ].join("\n"),
    safeHttpUrlHelper()
  );

  out = replaceOnce(
    out,
    "        click_url=_clean_text(data.get(\"click_url\")),",
    "        click_url=_safe_http_url(data.get(\"click_url\")),"
  );

  out = insertAfterOnce(
    out,
    [
      "    if ad is None:",
      "        return \"\"",
      "    return _clean_text(ad.ad_text, max_length=max(0, int(max_length)))",
    ].join("\n"),
    currentAdLinkHelper()
  );

  return out;
});

patchFile(commandsFile, (src) => {
  let out = src;

  out = insertAfterOnce(
    out,
    "    CommandDef(\"status\", \"Show session info\", \"Session\"),",
    [
      "    CommandDef(\"kickbacks\", \"Show Kickbacks ad and auth status\", \"Info\"),",
      "    CommandDef(\"kickbacks-signin\", \"Show Kickbacks sign-in help\", \"Info\",",
      "               aliases=(\"kickbacks_signin\",)),",
      "    CommandDef(\"kickbacks-debug\", \"Show Kickbacks cache debug info\", \"Info\",",
      "               aliases=(\"kickbacks_debug\",)),",
    ].join("\n")
  );

  return out;
});

patchFile(cliFile, (src) => {
  let out = src;

  out = insertAfterOnce(
    out,
    "        self._kickbacks_ad_text: str = \"\"",
    "        self._kickbacks_ad_url: str = \"\""
  );

  out = insertAfterOnce(
    out,
    "        self._spinner_text: str = \"\"  # thinking spinner text for TUI",
    [
      "        self._kickbacks_ad_text: str = \"\"",
      "        self._kickbacks_ad_url: str = \"\"",
      "        self._kickbacks_ad_expires_at: float = 0.0",
    ].join("\n")
  );

  out = replaceOnce(
    out,
    "            from hermes_cli.kickbacks import current_ad_text",
    "            from hermes_cli.kickbacks import current_ad_link"
  );

  out = replaceOnce(
    out,
    "            self._kickbacks_ad_text = current_ad_text(max_length=80, fresh_seconds=600)",
    [
      "            self._kickbacks_ad_text, self._kickbacks_ad_url = current_ad_link(",
      "                max_length=80,",
      "                fresh_seconds=600,",
      "            )",
    ].join("\n")
  );

  out = insertAfterOnce(
    out,
    "            self._kickbacks_ad_text = \"\"",
    "            self._kickbacks_ad_url = \"\""
  );

  out = replaceOnce(
    out,
    [
      "    def _render_spinner_text(self) -> str:",
      "        \"\"\"Return the live spinner/status text exactly as rendered in the TUI.\"\"\"",
      "        txt = getattr(self, \"_spinner_text\", \"\")",
      "        if not txt:",
      "            return \"\"",
      "        t0 = getattr(self, \"_tool_start_time\", 0) or 0",
      "        if t0 > 0:",
      "            elapsed = time.monotonic() - t0",
      "            if elapsed >= 60:",
      "                _m, _s = int(elapsed // 60), int(elapsed % 60)",
      "                # Fixed-width timer to avoid status-line wrap jitter while",
      "                # scrolling/repainting (e.g. 01m05s, 12m09s).",
      "                elapsed_str = f\"{_m:02d}m{_s:02d}s\"",
      "            else:",
      "                # Keep width stable before the 60s rollover as well.",
      "                elapsed_str = f\"{elapsed:5.1f}s\"",
      "            return f\"  {txt}  ({elapsed_str})\"",
      "        return f\"  {txt}\"",
    ].join("\n"),
    spinnerRenderHelpers()
  );

  out = insertAfterOnce(
    out,
    [
      "        elif canonical == \"status\":",
      "            self._show_session_status()",
    ].join("\n"),
    [
      "        elif canonical in {\"kickbacks\", \"kickbacks-signin\", \"kickbacks-debug\"}:",
      "            from hermes_cli.kickbacks import handle_kickbacks_command",
      "",
      "            _cprint(handle_kickbacks_command(cmd_original))",
    ].join("\n")
  );

  out = replaceOnce(
    out,
    [
      "        def get_spinner_text():",
      "            spinner_line = cli_ref._render_spinner_text()",
      "            if not spinner_line:",
      "                return []",
      "            return [('class:hint', spinner_line)]",
    ].join("\n"),
    [
      "        def get_spinner_text():",
      "            return cli_ref._render_spinner_fragments()",
    ].join("\n")
  );

  return out;
});

patchFile(testFile, (src) => {
  let out = src;

  if (!out.includes("def test_current_ad_link_returns_text_and_safe_url")) {
    out = insertAfterOnce(
      out,
      "        reset_hermes_home_override(token)",
      currentAdLinkTests()
    );
  }

  if (!out.includes("def test_cli_spinner_fragments_wrap_ad_with_osc8_link")) {
    out = `${out.trimEnd()}\n\n${spinnerFragmentTest()}\n`;
  }

  return out;
});

console.log("Hermes classic CLI clickable Kickbacks ads patched.");

function patchFile(file, fn) {
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after !== before) {
    writeFileSync(file, after, "utf8");
  }
}

function kickbacksHelperTemplate() {
  return [
    "\"\"\"Native Kickbacks helpers for Hermes CLI surfaces.\"\"\"",
    "",
    "from __future__ import annotations",
    "",
    "import json",
    "import os",
    "import sys",
    "import time",
    "from dataclasses import dataclass",
    "from pathlib import Path",
    "from typing import Any, Iterable",
    "from urllib.parse import urlparse",
    "",
    "from hermes_constants import get_hermes_home, get_hermes_home_override",
    "",
    "DEFAULT_MAX_LENGTH = 80",
    "DEFAULT_FRESH_SECONDS = 600",
    "KICKBACKS_SITE_URL = \"https://kickbacks.ai/\"",
    "",
    "",
    "@dataclass(frozen=True)",
    "class KickbacksAd:",
    "    ad_text: str",
    "    click_url: str = \"\"",
    "    campaign_id: str = \"\"",
    "    ad_id: str = \"\"",
    "    brand_name: str = \"\"",
    "    demo: bool = False",
    "    ts_seconds: float | None = None",
    "    age_seconds: float | None = None",
    "    source_path: Path | None = None",
    "",
    "",
    "def _candidate_paths() -> list[Path]:",
    "    candidates = [get_hermes_home() / \"kickbacks\" / \"hermes-ad.json\"]",
    "    if not get_hermes_home_override():",
    "        candidates.extend([Path.home() / \".kickbacks\" / \"hermes-ad.json\", Path.home() / \".vibe-ads\" / \"hermes-ad.json\"])",
    "    seen: set[str] = set()",
    "    unique: list[Path] = []",
    "    for path in candidates:",
    "        key = os.path.normcase(str(path.expanduser()))",
    "        if key not in seen:",
    "            seen.add(key)",
    "            unique.append(path.expanduser())",
    "    return unique",
    "",
    "",
    "def kickbacks_cache_paths() -> list[Path]:",
    "    return _candidate_paths()",
    "",
    "",
    "def _clean_text(value: Any, *, max_length: int = 0) -> str:",
    "    if not isinstance(value, str):",
    "        return \"\"",
    "    text = \" \".join(value.split())",
    "    text = \"\".join(ch for ch in text if ch.isprintable())",
    "    if max_length and len(text) > max_length:",
    "        return text[: max(0, max_length - 1)].rstrip() + \"...\"",
    "    return text",
    "",
    "",
    "def _safe_http_url(value: Any) -> str:",
    "    url = _clean_text(value)",
    "    if not url:",
    "        return \"\"",
    "    parsed = urlparse(url)",
    "    if parsed.scheme not in {\"http\", \"https\"} or not parsed.netloc:",
    "        return \"\"",
    "    return url",
    "",
    "",
    "def _timestamp_seconds(value: Any) -> float | None:",
    "    if not isinstance(value, (int, float)):",
    "        return None",
    "    ts = float(value)",
    "    if ts <= 0:",
    "        return None",
    "    if ts > 1_000_000_000_000:",
    "        ts /= 1000",
    "    return ts",
    "",
    "",
    "def _load_ad_from_path(path: Path, *, fresh_seconds: int) -> KickbacksAd | None:",
    "    try:",
    "        data = json.loads(path.read_text(encoding=\"utf-8\"))",
    "    except (json.JSONDecodeError, OSError, UnicodeDecodeError):",
    "        return None",
    "    if not isinstance(data, dict):",
    "        return None",
    "    ad_text = _clean_text(data.get(\"ad_text\"))",
    "    if not ad_text:",
    "        return None",
    "    now = time.time()",
    "    ts_seconds = _timestamp_seconds(data.get(\"ts\"))",
    "    if ts_seconds is None:",
    "        try:",
    "            ts_seconds = path.stat().st_mtime",
    "        except OSError:",
    "            ts_seconds = None",
    "    age_seconds: float | None = None",
    "    if ts_seconds is not None:",
    "        age_seconds = now - ts_seconds",
    "        if fresh_seconds:",
    "            max_age = max(0, int(fresh_seconds))",
    "            if age_seconds > max_age or age_seconds < -max_age:",
    "                return None",
    "    return KickbacksAd(",
    "        ad_text=ad_text,",
    "        click_url=_safe_http_url(data.get(\"click_url\")),",
    "        campaign_id=_clean_text(data.get(\"campaign_id\")),",
    "        ad_id=_clean_text(data.get(\"ad_id\")),",
    "        brand_name=_clean_text(data.get(\"brand_name\") or data.get(\"advertiser\")),",
    "        demo=bool(data.get(\"demo\")),",
    "        ts_seconds=ts_seconds,",
    "        age_seconds=max(0, age_seconds) if age_seconds is not None else None,",
    "        source_path=path,",
    "    )",
    "",
    "",
    "def _current_ad(*, fresh_seconds: int = DEFAULT_FRESH_SECONDS, include_demo: bool) -> KickbacksAd | None:",
    "    for path in _candidate_paths():",
    "        ad = _load_ad_from_path(path, fresh_seconds=max(0, int(fresh_seconds)))",
    "        if ad is not None and (include_demo or not ad.demo):",
    "            return ad",
    "    return None",
    "",
    "",
    "def current_ad(*, fresh_seconds: int = DEFAULT_FRESH_SECONDS) -> KickbacksAd | None:",
    "    return _current_ad(fresh_seconds=fresh_seconds, include_demo=True)",
    "",
    "",
    "def current_ad_text(*, max_length: int = DEFAULT_MAX_LENGTH, fresh_seconds: int = DEFAULT_FRESH_SECONDS, include_demo: bool = False) -> str:",
    "    ad = _current_ad(fresh_seconds=fresh_seconds, include_demo=include_demo)",
    "    if ad is None:",
    "        return \"\"",
    "    return _clean_text(ad.ad_text, max_length=max(0, int(max_length)))",
    "",
    "",
    "def current_ad_link(*, max_length: int = DEFAULT_MAX_LENGTH, fresh_seconds: int = DEFAULT_FRESH_SECONDS, include_demo: bool = False) -> tuple[str, str]:",
    "    \"\"\"Return compact ad text plus a safe click URL for clickable UI surfaces.\"\"\"",
    "    ad = _current_ad(fresh_seconds=fresh_seconds, include_demo=include_demo)",
    "    if ad is None or not ad.click_url:",
    "        return \"\", \"\"",
    "    return _clean_text(ad.ad_text, max_length=max(0, int(max_length))), ad.click_url",
    "",
    "",
    "def current_ad_line(*, max_length: int = DEFAULT_MAX_LENGTH, fresh_seconds: int = DEFAULT_FRESH_SECONDS, include_url: bool = True) -> str:",
    "    ad = current_ad(fresh_seconds=fresh_seconds)",
    "    if ad is None:",
    "        return \"\"",
    "    text = _clean_text(ad.ad_text, max_length=max(0, int(max_length)))",
    "    if include_url and ad.click_url:",
    "        return f\"Kickbacks: {text} -> {ad.click_url}\"",
    "    return f\"Kickbacks: {text}\"",
    "",
    "",
    "def refresh_ad_cache_from_plugin() -> bool:",
    "    if get_hermes_home_override():",
    "        return False",
    "    plugin_parent = Path.home() / \".hermes\" / \"plugins\"",
    "    if not (plugin_parent / \"kickbacks\" / \"api.py\").exists():",
    "        return False",
    "    parent_str = str(plugin_parent)",
    "    inserted = False",
    "    if parent_str not in sys.path:",
    "        sys.path.insert(0, parent_str)",
    "        inserted = True",
    "    try:",
    "        from kickbacks import api  # type: ignore",
    "        resp = api.fetch_portfolio(\"hermes/0.1.0\")",
    "        if not resp or not resp.ad:",
    "            return False",
    "        api.write_ad_cache(resp.ad)",
    "        return True",
    "    except Exception:",
    "        return False",
    "    finally:",
    "        if inserted:",
    "            try:",
    "                sys.path.remove(parent_str)",
    "            except ValueError:",
    "                pass",
    "",
    "",
    "def _format_age(age: float | None) -> str:",
    "    if age is None:",
    "        return \"unknown\"",
    "    if age < 60:",
    "        return f\"{int(age)}s\"",
    "    if age < 3600:",
    "        return f\"{int(age // 60)}m {int(age % 60)}s\"",
    "    return f\"{int(age // 3600)}h {int((age % 3600) // 60)}m\"",
    "",
    "",
    "def _auth_paths() -> Iterable[Path]:",
    "    yield Path.home() / \".kickbacks\" / \"auth.json\"",
    "    yield Path.home() / \".vibe-ads\" / \"auth.json\"",
    "",
    "",
    "def _auth_summary() -> str:",
    "    for path in _auth_paths():",
    "        try:",
    "            data = json.loads(path.read_text(encoding=\"utf-8\"))",
    "        except (json.JSONDecodeError, OSError, UnicodeDecodeError):",
    "            continue",
    "        if not isinstance(data, dict):",
    "            continue",
    "        has_access = bool(data.get(\"access_token\"))",
    "        has_refresh = bool(data.get(\"refresh\") or data.get(\"refresh_token\"))",
    "        client_id = data.get(\"clientId\") or data.get(\"client_id\")",
    "        parts = [f\"file={path}\", f\"access={'present' if has_access else 'missing'}\", f\"refresh={'present' if has_refresh else 'missing'}\"]",
    "        if isinstance(client_id, str) and client_id:",
    "            parts.append(f\"client={client_id[:8]}...\")",
    "        return \", \".join(parts)",
    "    return \"no auth file found\"",
    "",
    "",
    "def _status_text() -> str:",
    "    refresh_ad_cache_from_plugin()",
    "    ad = current_ad()",
    "    lines = [\"Kickbacks: enabled\", f\"Auth: {_auth_summary()}\"]",
    "    if ad is None:",
    "        lines.append(\"Current ad: none found in a fresh cache\")",
    "        lines.append(f\"Sign in or learn more: {KICKBACKS_SITE_URL}\")",
    "        lines.append(\"Commands: /kickbacks, /kickbacks-signin, /kickbacks-debug\")",
    "        return \"\\n\".join(lines)",
    "    lines.append(f\"Current ad: {ad.ad_text}\")",
    "    if ad.click_url:",
    "        lines.append(f\"Click URL: {ad.click_url}\")",
    "    if ad.source_path:",
    "        lines.append(f\"Cache: {ad.source_path}\")",
    "    lines.append(f\"Age: {_format_age(ad.age_seconds)}\")",
    "    lines.append(f\"Mode: {'demo / not earning' if ad.demo else 'signed-in inventory'}\")",
    "    if ad.demo:",
    "        lines.append(\"Use /kickbacks-signin if Hermes should refresh real signed-in inventory.\")",
    "    lines.append(\"Commands: /kickbacks, /kickbacks-signin, /kickbacks-debug\")",
    "    return \"\\n\".join(lines)",
    "",
    "",
    "def _signin_text() -> str:",
    "    auth_locations = \", \".join(str(p) for p in _auth_paths())",
    "    return \"\\n\".join([\"Kickbacks sign-in\", f\"Open: {KICKBACKS_SITE_URL}\", \"Hermes reads the local Kickbacks cache; it never prints tokens.\", f\"Auth files checked by Kickbacks tooling: {auth_locations}\"])",
    "",
    "",
    "def _debug_text() -> str:",
    "    refreshed = refresh_ad_cache_from_plugin()",
    "    ad = current_ad()",
    "    lines = [\"Kickbacks debug\", f\"Refresh attempted: {'yes' if refreshed else 'no'}\", \"Cache lookup paths:\", *[f\"- {path} ({'exists' if path.exists() else 'missing'})\" for path in kickbacks_cache_paths()]]",
    "    if ad is None:",
    "        lines.append(\"Fresh ad: none\")",
    "    else:",
    "        lines.extend([f\"Fresh ad: {ad.ad_text}\", f\"Source: {ad.source_path or 'unknown'}\", f\"Age: {_format_age(ad.age_seconds)}\", f\"Campaign ID: {ad.campaign_id or 'unknown'}\", f\"Ad ID: {ad.ad_id or 'unknown'}\", f\"Demo: {'yes' if ad.demo else 'no'}\"])",
    "    lines.append(\"Auth file presence:\")",
    "    for path in _auth_paths():",
    "        lines.append(f\"- {path}: {'present' if path.exists() else 'missing'}\")",
    "    lines.append(f\"Auth summary: {_auth_summary()}\")",
    "    return \"\\n\".join(lines)",
    "",
    "",
    "def handle_kickbacks_command(command: str) -> str:",
    "    base = command.strip().split(maxsplit=1)[0].lower().lstrip(\"/\")",
    "    if base in {\"kickbacks-signin\", \"kickbacks_signin\"}:",
    "        return _signin_text()",
    "    if base in {\"kickbacks-debug\", \"kickbacks_debug\"}:",
    "        return _debug_text()",
    "    return _status_text()",
    "",
  ].join("\n");
}

function kickbacksTestTemplate() {
  return [
    "from __future__ import annotations",
    "",
    "import json",
    "import time",
    "",
    "from hermes_constants import reset_hermes_home_override, set_hermes_home_override",
    "",
    "",
    "def test_current_ad_reads_from_hermes_home_and_formats_line(tmp_path):",
    "    from hermes_cli.kickbacks import current_ad_line",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(",
    "            json.dumps({\"ad_text\": \"Gravity - The Ad Network for AI\", \"click_url\": \"https://trygravity.ai/\", \"campaign_id\": \"campaign-123\", \"ad_id\": \"ad-456\", \"demo\": True, \"ts\": int(time.time() * 1000)}),",
    "            encoding=\"utf-8\",",
    "        )",
    "        assert current_ad_line(max_length=80, fresh_seconds=60) == \"Kickbacks: Gravity - The Ad Network for AI -> https://trygravity.ai/\"",
    "    finally:",
    "        reset_hermes_home_override(token)",
    "",
    "",
    "def test_current_ad_ignores_stale_cache(tmp_path):",
    "    from hermes_cli.kickbacks import current_ad_line",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(json.dumps({\"ad_text\": \"Old campaign\", \"ts\": int((time.time() - 3600) * 1000)}), encoding=\"utf-8\")",
    "        assert current_ad_line(max_length=80, fresh_seconds=60) == \"\"",
    "    finally:",
    "        reset_hermes_home_override(token)",
    "",
    "",
    "def test_current_ad_text_hides_demo_ads_by_default(tmp_path):",
    "    from hermes_cli.kickbacks import current_ad_text",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(json.dumps({\"ad_text\": \"Demo sponsor\", \"demo\": True, \"ts\": int(time.time() * 1000)}), encoding=\"utf-8\")",
    "        assert current_ad_text(fresh_seconds=60) == \"\"",
    "        assert current_ad_text(fresh_seconds=60, include_demo=True) == \"Demo sponsor\"",
    "    finally:",
    "        reset_hermes_home_override(token)",
    currentAdLinkTests(),
    "",
    "",
    "def test_kickbacks_commands_are_registered():",
    "    from hermes_cli.commands import COMMANDS, resolve_command",
    "",
    "    for name in (\"/kickbacks\", \"/kickbacks-signin\", \"/kickbacks-debug\"):",
    "        assert name in COMMANDS",
    "        assert resolve_command(name) is not None",
    "",
    "",
    "def test_kickbacks_command_status_reports_ad_and_debug_path(tmp_path):",
    "    from hermes_cli.kickbacks import handle_kickbacks_command",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(",
    "            json.dumps({\"ad_text\": \"Ramp - save time and money\", \"click_url\": \"https://ramp.com/\", \"campaign_id\": \"campaign-1\", \"ad_id\": \"ad-1\", \"ts\": int(time.time() * 1000)}),",
    "            encoding=\"utf-8\",",
    "        )",
    "        status = handle_kickbacks_command(\"/kickbacks\")",
    "        debug = handle_kickbacks_command(\"/kickbacks-debug\")",
    "        assert \"Kickbacks: enabled\" in status",
    "        assert \"Ramp - save time and money\" in status",
    "        assert str(ad_dir / \"hermes-ad.json\") in debug",
    "        assert \"campaign-1\" in debug",
    "    finally:",
    "        reset_hermes_home_override(token)",
    "",
    spinnerFragmentTest(),
    "",
  ].join("\n");
}

function replaceOnce(src, needle, replacement) {
  if (src.includes(replacement)) return src;
  if (!src.includes(needle)) return src;
  return src.replace(needle, replacement);
}

function insertAfterOnce(src, needle, insertion) {
  if (!insertion || src.includes(insertion.trim())) return src;
  if (!src.includes(needle)) return src;
  return src.replace(needle, `${needle}\n${insertion}`);
}

function safeHttpUrlHelper() {
  return [
    "",
    "",
    "def _safe_http_url(value: Any) -> str:",
    "    url = _clean_text(value)",
    "    if not url:",
    "        return \"\"",
    "    parsed = urlparse(url)",
    "    if parsed.scheme not in {\"http\", \"https\"} or not parsed.netloc:",
    "        return \"\"",
    "    return url",
  ].join("\n");
}

function currentAdLinkHelper() {
  return [
    "",
    "",
    "def current_ad_link(",
    "    *,",
    "    max_length: int = DEFAULT_MAX_LENGTH,",
    "    fresh_seconds: int = DEFAULT_FRESH_SECONDS,",
    "    include_demo: bool = False,",
    ") -> tuple[str, str]:",
    "    \"\"\"Return compact ad text plus a safe click URL for clickable UI surfaces.\"\"\"",
    "    ad = _current_ad(fresh_seconds=fresh_seconds, include_demo=include_demo)",
    "    if ad is None or not ad.click_url:",
    "        return \"\", \"\"",
    "    return _clean_text(ad.ad_text, max_length=max(0, int(max_length))), ad.click_url",
  ].join("\n");
}

function spinnerRenderHelpers() {
  return [
    "    def _refresh_kickbacks_ad_text(self, *, force: bool = False) -> str:",
    "        \"\"\"Refresh the compact Kickbacks ad suffix used by the CLI spinner.\"\"\"",
    "        now = time.monotonic()",
    "        if not force and now < getattr(self, \"_kickbacks_ad_expires_at\", 0.0):",
    "            return getattr(self, \"_kickbacks_ad_text\", \"\") or \"\"",
    "        try:",
    "            from hermes_cli.kickbacks import current_ad_link",
    "",
    "            self._kickbacks_ad_text, self._kickbacks_ad_url = current_ad_link(",
    "                max_length=80,",
    "                fresh_seconds=600,",
    "            )",
    "        except Exception:",
    "            self._kickbacks_ad_text = \"\"",
    "            self._kickbacks_ad_url = \"\"",
    "        self._kickbacks_ad_expires_at = now + 10",
    "        return self._kickbacks_ad_text",
    "",
    "    def _render_spinner_text(self) -> str:",
    "        \"\"\"Return the live spinner/status text exactly as rendered in the TUI.\"\"\"",
    "        txt = getattr(self, \"_spinner_text\", \"\")",
    "        ad = self._refresh_kickbacks_ad_text() if (txt or getattr(self, \"_agent_running\", False)) else \"\"",
    "        base = \"\"",
    "        if txt:",
    "            t0 = getattr(self, \"_tool_start_time\", 0) or 0",
    "            if t0 > 0:",
    "                elapsed = time.monotonic() - t0",
    "                if elapsed >= 60:",
    "                    _m, _s = int(elapsed // 60), int(elapsed % 60)",
    "                    elapsed_str = f\"{_m:02d}m{_s:02d}s\"",
    "                else:",
    "                    elapsed_str = f\"{elapsed:5.1f}s\"",
    "                base = f\"  {txt}  ({elapsed_str})\"",
    "            else:",
    "                base = f\"  {txt}\"",
    "        suffix = \"\"",
    "        if ad:",
    "            sep = \"  ·  \" if base else \"  \"",
    "            suffix = f\"{sep}{ad}\"",
    "        return f\"{base}{suffix}\"",
    "",
    "",
    "    def _render_spinner_fragments(self):",
    "        \"\"\"Return prompt_toolkit fragments for the spinner with a linked ad suffix.\"\"\"",
    "        line = self._render_spinner_text()",
    "        ad = getattr(self, \"_kickbacks_ad_text\", \"\") or \"\"",
    "        url = getattr(self, \"_kickbacks_ad_url\", \"\") or \"\"",
    "        if not line or not ad or not url or ad not in line:",
    "            return [('class:hint', line)] if line else []",
    "",
    "        before, after = line.split(ad, 1)",
    "        link = f\"\\x1b]8;;{url}\\x1b\\\\{ad}\\x1b]8;;\\x1b\\\\\"",
    "        fragments = []",
    "        if before:",
    "            fragments.append(('class:hint', before))",
    "        fragments.append(('class:hint underline', link))",
    "        if after:",
    "            fragments.append(('class:hint', after))",
    "        return fragments",
  ].join("\n");
}

function currentAdLinkTests() {
  return [
    "",
    "",
    "def test_current_ad_link_returns_text_and_safe_url(tmp_path):",
    "    from hermes_cli.kickbacks import current_ad_link",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(",
    "            json.dumps(",
    "                {",
    "                    \"ad_text\": \"Sundial: Actually trustworthy AI data engineering + analysis\",",
    "                    \"click_url\": \"https://sundial.so/\",",
    "                    \"ts\": int(time.time() * 1000),",
    "                }",
    "            ),",
    "            encoding=\"utf-8\",",
    "        )",
    "",
    "        assert current_ad_link(fresh_seconds=60) == (",
    "            \"Sundial: Actually trustworthy AI data engineering + analysis\",",
    "            \"https://sundial.so/\",",
    "        )",
    "    finally:",
    "        reset_hermes_home_override(token)",
    "",
    "",
    "def test_current_ad_link_rejects_non_http_url(tmp_path):",
    "    from hermes_cli.kickbacks import current_ad_link",
    "",
    "    token = set_hermes_home_override(tmp_path)",
    "    try:",
    "        ad_dir = tmp_path / \"kickbacks\"",
    "        ad_dir.mkdir()",
    "        (ad_dir / \"hermes-ad.json\").write_text(",
    "            json.dumps(",
    "                {",
    "                    \"ad_text\": \"Bad URL\",",
    "                    \"click_url\": \"file:///tmp/bad\",",
    "                    \"ts\": int(time.time() * 1000),",
    "                }",
    "            ),",
    "            encoding=\"utf-8\",",
    "        )",
    "",
    "        assert current_ad_link(fresh_seconds=60) == (\"\", \"\")",
    "    finally:",
    "        reset_hermes_home_override(token)",
  ].join("\n");
}

function spinnerFragmentTest() {
  return [
    "def test_cli_spinner_fragments_wrap_ad_with_osc8_link(monkeypatch):",
    "    import cli as cli_module",
    "",
    "    cli = object.__new__(cli_module.HermesCLI)",
    "    cli._spinner_text = \"⠋ thinking\"",
    "    cli._tool_start_time = 0.0",
    "    cli._agent_running = True",
    "    cli._kickbacks_ad_text = \"Sundial: Actually trustworthy AI data engineering + analysis\"",
    "    cli._kickbacks_ad_url = \"https://sundial.so/\"",
    "    cli._kickbacks_ad_expires_at = time.monotonic() + 60",
    "",
    "    monkeypatch.setattr(cli_module.HermesCLI, \"_invalidate\", lambda self: None)",
    "",
    "    fragments = cli._render_spinner_fragments()",
    "    rendered = \"\".join(text for _, text in fragments)",
    "",
    "    assert \"Sundial: Actually trustworthy AI data engineering + analysis\" in rendered",
    "    assert \"\\x1b]8;;https://sundial.so/\\x1b\\\\\" in rendered",
    "    assert rendered.endswith(\"\\x1b]8;;\\x1b\\\\\")",
  ].join("\n");
}
