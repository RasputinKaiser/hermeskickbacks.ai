"""
Kickbacks.ai — Hermes Agent Plugin

Get paid for waiting. Monetizes Hermes Agent's thinking/processing wait states
into sponsored ad placements. Connects to kickbacks.ai for ad inventory,
impression tracking, and revenue sharing (up to 50%).

Hooks:
  - pre_llm_call: starts "thinking" state, shows ad
  - post_llm_call: stops "thinking" state, hides ad
  - pre_tool_call: tracks tool execution for impression timing
  - post_tool_call: tracks tool completion
  - on_session_start: initializes ad fetching
  - on_session_end: cleanup

Slash Commands:
  - /kickbacks: show earnings, ad status, and controls
  - /kickbacks-signin: start Google OAuth sign-in flow
  - /kickbacks-signout: sign out and clear auth
  - /kickbacks-debug: show detailed debug info
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import api
from .tracker import ImpressionTracker


# ── Plugin State ────────────────────────────────────────────────────────────

_tracker: ImpressionTracker | None = None
_fetch_timer: threading.Timer | None = None
_fetch_lock = threading.Lock()
_portfolio_response: api.PortfolioResponse | None = None
_rotation_index: int = 0
_last_fetch_time: float = 0.0
_hermes_version: str = "hermes/0.1.0"


def _env_int(name: str, default: int, *, min_value: int = 0, max_value: int = 3_600_000) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(max_value, value))


CACHE_FALLBACK_MAX_AGE_MS = _env_int("KICKBACKS_CACHE_FALLBACK_MAX_AGE_MS", 15 * 60 * 1000)


# ── Plugin Register ─────────────────────────────────────────────────────────

def register(ctx):
    """Register the Kickbacks plugin with Hermes Agent."""
    global _tracker, _hermes_version

    # Try to get Hermes version
    try:
        import hermes_constants
        _hermes_version = f"hermes/{getattr(hermes_constants, '__version__', '0.1.0')}"
    except ImportError:
        pass

    _tracker = ImpressionTracker(hermes_version=_hermes_version)

    # ── Hooks ───────────────────────────────────────────────────────────

    def on_pre_llm_call(*args, **kwargs):
        """Hermes is about to call the LLM — show ad during wait."""
        try:
            _tracker.start()
        except Exception:
            pass
        # Return None = no modification to messages/tools
        return None

    def on_post_llm_call(*args, **kwargs):
        """Hermes finished the LLM call — stop ad display."""
        try:
            _tracker.stop()
        except Exception:
            pass

    def on_pre_tool_call(*args, **kwargs):
        """About to execute a tool — track for impression timing."""
        try:
            _tracker.start()
        except Exception:
            pass

    def on_post_tool_call(*args, **kwargs):
        """Tool execution finished — update impression timing."""
        try:
            _tracker.stop()
        except Exception:
            pass

    def on_session_start(**kwargs):
        """New session: fetch initial ad portfolio."""
        try:
            _fetch_and_rotate_ads()
        except Exception:
            pass

    def on_session_end(**kwargs):
        """Session ending: cleanup."""
        try:
            _tracker.shutdown()
            _cancel_fetch_timer()
        except Exception:
            pass

    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("post_llm_call", on_post_llm_call)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)

    # ── Slash Commands ──────────────────────────────────────────────────

    def cmd_kickbacks(args: str) -> str:
        """Show Kickbacks status, earnings, and current ad."""
        return _handle_kickbacks_command(args)

    def cmd_kickbacks_signin(args: str) -> str:
        """Start Google OAuth sign-in with kickbacks.ai."""
        return _handle_signin_command(args)

    def cmd_kickbacks_signout(args: str) -> str:
        """Sign out from kickbacks.ai."""
        return _handle_signout_command(args)

    def cmd_kickbacks_debug(args: str) -> str:
        """Show debug information about the Kickbacks plugin."""
        return _handle_debug_command(args)

    ctx.register_command("kickbacks", cmd_kickbacks, "Show Kickbacks earnings and ad status")
    ctx.register_command("kickbacks-signin", cmd_kickbacks_signin, "Sign in to kickbacks.ai with Google")
    ctx.register_command("kickbacks-signout", cmd_kickbacks_signout, "Sign out from kickbacks.ai")
    ctx.register_command("kickbacks-debug", cmd_kickbacks_debug, "Show Kickbacks debug info")

    # ── Start background ad fetching ────────────────────────────────────

    # Do an immediate fetch on plugin load
    _fetch_and_rotate_ads()
    # Then schedule subsequent fetches
    _schedule_fetch()

    # Print activation message (visible in Hermes logs)
    signed_in = api.is_signed_in()
    print(f"[kickbacks] Plugin activated (signed_in={signed_in}, hermes={_hermes_version})")


# ── Ad Fetching & Rotation ──────────────────────────────────────────────────

def _fetch_and_rotate_ads() -> None:
    """Fetch portfolio from backend and rotate to next ad."""
    global _portfolio_response, _rotation_index, _last_fetch_time

    with _fetch_lock:
        try:
            resp = api.fetch_portfolio(hermes_version=_hermes_version)
            if resp and resp.ads:
                _portfolio_response = resp
                _last_fetch_time = time.time()

                # Rotate to next ad
                if len(resp.ads) > 1:
                    _rotation_index = (_rotation_index + 1) % len(resp.ads)
                else:
                    _rotation_index = 0

                current_ad = resp.ads[_rotation_index]
                # Attach view threshold from portfolio response
                current_ad._view_threshold_ms = resp.view_threshold_ms
                _tracker.set_ad(current_ad)
            elif resp and not resp.ads:
                cached_ad = _cached_ad_fallback()
                _tracker.set_ad(cached_ad, write_cache=False)
            else:
                cached_ad = _cached_ad_fallback()
                if cached_ad:
                    _tracker.set_ad(cached_ad, write_cache=False)
        except Exception as e:
            print(f"[kickbacks] Fetch error: {e}")

    _schedule_fetch()


def _cached_ad_fallback() -> api.PatchAd | None:
    """Return a fresh cached ad when live portfolio fetch is unavailable."""
    data = api.read_ad_cache()
    if not data:
        return None

    ts = data.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    age_ms = int(time.time() * 1000 - ts)
    if age_ms < 0 or age_ms > CACHE_FALLBACK_MAX_AGE_MS:
        print(f"[kickbacks] Cache fallback skipped: age_ms={age_ms}", flush=True)
        return None

    ad_id = data.get("ad_id")
    campaign_id = data.get("campaign_id")
    ad_text = data.get("ad_text")
    if not all(isinstance(value, str) and value for value in (ad_id, campaign_id, ad_text)):
        return None

    raw = {
        "ad_id": ad_id,
        "campaign_id": campaign_id,
        "title_text": ad_text,
        "icon_ref": data.get("icon_ref", ""),
        "icon_url": data.get("icon_url", ""),
        "click_url": data.get("click_url", ""),
        "banner_enabled": bool(data.get("banner_enabled", False)),
        "session_token": data.get("session_token", ""),
    }
    print(f"[kickbacks] Using cached ad fallback age_ms={age_ms}", flush=True)
    return api.PatchAd(raw, demo=bool(data.get("demo", False)))


def _schedule_fetch() -> None:
    """Schedule next portfolio fetch based on rotation interval."""
    global _fetch_timer

    _cancel_fetch_timer()

    interval_sec = 60  # Default: fetch every 60s
    if _portfolio_response:
        interval_sec = max(15, _portfolio_response.rotation_interval_ms // 1000)

    def _do_fetch():
        _fetch_and_rotate_ads()

    _fetch_timer = threading.Timer(interval_sec, _do_fetch)
    _fetch_timer.daemon = True
    _fetch_timer.start()


def _cancel_fetch_timer() -> None:
    global _fetch_timer
    if _fetch_timer:
        _fetch_timer.cancel()
        _fetch_timer = None


# ── Command Handlers ────────────────────────────────────────────────────────

def _handle_kickbacks_command(args: str) -> str:
    """Handle /kickbacks command — show status and earnings."""
    lines = []
    lines.append("🤑 **Kickbacks.ai**")
    lines.append("")

    signed_in = api.is_signed_in()
    if signed_in:
        lines.append("✅ Signed in")
        earnings = api.fetch_earnings()
        if earnings:
            today = earnings.get("today_usd", "0.00")
            lifetime = earnings.get("lifetime_usd", "0.00")
            lines.append(f"💰 Today: **${today}**  |  Lifetime: **${lifetime}**")
        else:
            lines.append("💰 Earnings: loading...")
    else:
        lines.append("🔓 Signed out (demo mode — no earnings)")
        lines.append("   Use `/kickbacks-signin` to sign in and earn revenue share.")
    lines.append("")

    # Current ad
    status = _tracker.get_status() if _tracker else {}
    if status.get("ad_text"):
        lines.append(f"📢 **Current ad:** {status['ad_text']}")
        demo_tag = " [demo]" if status.get("demo") else ""
        lines.append(f"   Ad ID: `{status['ad_id']}`{demo_tag}")
        elapsed = status.get("elapsed_ms", 0)
        lines.append(f"   Elapsed: {elapsed // 1000}s")
    else:
        lines.append("📢 No ad currently loaded")
    lines.append("")

    # Stats
    lines.append(f"👁  Ad showing: {'yes' if status.get('showing') else 'no'}")
    lines.append(f"📊 Correlation: `{status.get('corr', 'none')}`")

    return "\n".join(lines)


def _handle_signin_command(args: str) -> str:
    """Handle /kickbacks-signin — start Google OAuth flow."""
    if api.is_signed_in():
        return "✅ You are already signed in to kickbacks.ai!"

    url = api.start_sign_in()
    if not url:
        return "❌ Could not initiate sign-in. The kickbacks.ai backend may be unreachable.\n\nTry again later, or check your network connection."

    # Copy URL to clipboard (macOS) — always attempt, independent of browser
    clipboard_copied = False
    try:
        import subprocess
        subprocess.run(["pbcopy"], input=url.encode(), check=True, timeout=5)
        clipboard_copied = True
    except Exception:
        pass

    # Auto-open the URL in the browser
    browser_opened = False
    try:
        import webbrowser
        webbrowser.open(url)
        browser_opened = True
    except Exception:
        pass

    # Start polling in a background thread
    def _poll():
        success = api.poll_sign_in(timeout_seconds=180)
        if success:
            print("[kickbacks] Sign-in successful! Refreshing ads...")
            _fetch_and_rotate_ads()
        else:
            print("[kickbacks] Sign-in timed out or failed.")

    poll_thread = threading.Thread(target=_poll, daemon=True)
    poll_thread.start()

    msg = "🔐 **Sign in to kickbacks.ai**\n\n"
    if browser_opened:
        msg += "✅ Browser opened automatically!\n"
        msg += "   If it didn't open, use the URL below:\n\n"

    msg += "1. Open this URL in your browser:\n"
    msg += f"   {url}\n\n"
    msg += "2. Complete the Google sign-in flow\n"
    msg += "3. Return here — I'm polling for your token (3 min timeout)\n\n"

    if clipboard_copied:
        msg += "📋 URL copied to clipboard — paste (⌘V) into your browser if needed.\n\n"

    msg += "You'll earn up to **50% of ad revenue** from ads shown during your Hermes sessions."
    return msg


def _handle_signout_command(args: str) -> str:
    """Handle /kickbacks-signout — clear auth."""
    if not api.is_signed_in():
        return "🔓 You are not signed in to kickbacks.ai."

    api.sign_out()
    _tracker.set_ad(None)
    return "👋 Signed out from kickbacks.ai. Your ads and earnings data have been cleared locally."


def _handle_debug_command(args: str) -> str:
    """Handle /kickbacks-debug — show detailed debug info."""
    lines = ["🔧 **Kickbacks Debug Info**", ""]

    # Auth
    lines.append("**Auth:**")
    lines.append(f"  Signed in: {api.is_signed_in()}")
    lines.append(f"  Client ID: `{api.get_client_id()[:16]}...`")
    lines.append(f"  Auth file: `{api.AUTH_FILE}`")
    lines.append("")

    # Portfolio
    lines.append("**Portfolio:**")
    if _portfolio_response:
        lines.append(f"  Ads available: {len(_portfolio_response.ads)}")
        lines.append(f"  Queue ID: `{_portfolio_response.queue_id}`")
        lines.append(f"  Rotation interval: {_portfolio_response.rotation_interval_ms}ms")
        lines.append(f"  View threshold: {_portfolio_response.view_threshold_ms}ms")
        lines.append(f"  TTL: {_portfolio_response.ttl_ms}ms")
    else:
        lines.append("  No portfolio loaded yet")
    lines.append("")

    # Tracker
    lines.append("**Tracker:**")
    if _tracker:
        status = _tracker.get_status()
        lines.append(f"  Showing: {status['showing']}")
        lines.append(f"  Elapsed: {status['elapsed_ms']}ms")
        lines.append(f"  Ad ID: {status['ad_id'] or 'none'}")
    lines.append("")

    # Cache
    lines.append("**Ad cache:**")
    cache = api.read_ad_cache()
    if cache:
        lines.append(f"  Cached ad: {cache.get('ad_text', 'none')}")
        lines.append(f"  Cached at: {cache.get('ts', 0)}")
        lines.append(f"  Demo: {cache.get('demo', False)}")
    else:
        lines.append("  No ad cached")
    lines.append("")

    # Backend
    lines.append(f"**Backend:** `{api._backend_base()}`")
    lines.append(f"**Hermes version:** `{_hermes_version}`")
    lines.append(f"**Plugin version:** 0.1.0")

    return "\n".join(lines)
