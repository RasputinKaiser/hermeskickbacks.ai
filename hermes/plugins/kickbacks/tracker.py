"""
Impression tracker for Hermes Kickbacks — simplified, robust version.

Monitors when Hermes is "thinking" (LLM calls in progress, tools running),
accrues visible time, and fires impression/click metrics to the backend.

Design:
  - Hook-driven state with a short grace timer for LLM/tool handoffs
  - Thread-safe with a reentrant lock
  - Billable events fire synchronously at transition boundaries
"""
from __future__ import annotations

import os
import time
import uuid
import threading
from typing import Optional, Callable

# Relative import for package use; fall back to absolute for standalone testing
try:
    from . import api
except ImportError:
    import api  # type: ignore[no-redef]


def _env_int(name: str, default: int, *, min_value: int = 0, max_value: int = 5_000) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(max_value, value))


# ── Constants ───────────────────────────────────────────────────────────────

VIEW_THRESHOLD_MS = 15_000     # Must be visible this long to count as "shown"
TICK_MS = 5_000                 # Upstream view_tick heartbeat cadence
MIN_IMPRESSION_MS = 1_000       # Minimum visible time to count as impression
AD_REST_MS = _env_int("KICKBACKS_REST_MS", 20_000, max_value=120_000)
UNBILLED_REST_MS = _env_int("KICKBACKS_UNBILLED_REST_MS", 0)
STOP_GRACE_MS = _env_int("KICKBACKS_STOP_GRACE_MS", 350)  # Bridge tiny LLM/tool handoff gaps
TICK_POLL_MS = _env_int("KICKBACKS_TICK_POLL_MS", 1_000, min_value=100, max_value=5_000)


class ImpressionTracker:
    """
    Tracks ad visibility and fires billing events.

    Lifecycle (driven by Hermes hooks):
      pre_llm_call / pre_tool_call → start()
      post_llm_call / post_tool_call → stop()
    """

    def __init__(self, hermes_version: str = "hermes/0.1.0"):
        self._hermes_version = hermes_version
        self._ad: Optional[api.PatchAd] = None
        self._corr: str = ""
        self._lock = threading.RLock()

        # State
        self._showing = False
        self._started_at: float = 0.0
        self._rest_until: float = 0.0
        self._session_nonce: str = ""
        self._last_ad_id: Optional[str] = None
        self._active_spans = 0
        self._stop_timer: Optional[threading.Timer] = None
        self._start_timer: Optional[threading.Timer] = None
        self._tick_timer: Optional[threading.Timer] = None
        self._capture_ad: Optional[api.PatchAd] = None
        self._capture_corr: str = ""
        self._last_tick_ms = 0
        self._threshold_met = False
        self._error_impression_count = 0

        # Callbacks
        self._on_ad_changed: Optional[Callable] = None

    # ── Public API ──────────────────────────────────────────────────────────

    @property
    def ad(self) -> Optional[api.PatchAd]:
        return self._ad

    @property
    def is_showing(self) -> bool:
        return self._showing

    def set_ad(self, ad: Optional[api.PatchAd], *, write_cache: bool = True) -> None:
        """Update the current ad."""
        with self._lock:
            old_id = self._ad.ad_id if self._ad else None
            self._ad = ad
            if ad:
                self._corr = f"{ad.ad_id}.{uuid.uuid4().hex[:8]}"
                if write_cache:
                    api.write_ad_cache(ad)
            if ad and ad.ad_id != old_id:
                self._last_ad_id = old_id
            if ad and self._active_spans > 0 and not self._showing:
                self._maybe_begin_capture_locked()
            if self._on_ad_changed:
                try:
                    self._on_ad_changed()
                except Exception:
                    pass

    def set_on_ad_changed(self, cb: Callable) -> None:
        self._on_ad_changed = cb

    def start(self) -> None:
        """
        Called when Hermes starts an LLM call or tool execution.
        Begins ad display and fires impression_rendered.
        """
        with self._lock:
            self._active_spans += 1
            self._cancel_stop_timer_locked()
            self._maybe_begin_capture_locked()

    def record_click(self, *, surface: str = "statusline") -> bool:
        """Record an operator click for the current ad."""
        with self._lock:
            ad = self._capture_ad or self._ad
            if not ad:
                return False
            corr = self._capture_corr or self._corr
            session_nonce = self._session_nonce

        try:
            return bool(api.send_metric(
                "click",
                ad,
                hermes_version=self._hermes_version,
                corr=corr,
                surface=surface,
                event_uuid=str(uuid.uuid4()),
                session_nonce=session_nonce,
                session_token=ad.session_token,
            ))
        except Exception:
            return False

    def _maybe_begin_capture_locked(self, now: Optional[float] = None) -> bool:
        if self._showing:
            self._schedule_tick_locked()
            return True
        if self._active_spans <= 0:
            self._cancel_start_timer_locked()
            return False
        if not self._ad:
            print("[kickbacks] start skipped: no ad", flush=True)
            return False

        now = time.time() if now is None else now
        if now < self._rest_until:
            self._schedule_start_after_rest_locked(now)
            return False

        self._cancel_start_timer_locked()
        self._showing = True
        self._started_at = now
        self._session_nonce = str(uuid.uuid4())
        self._capture_ad = self._ad
        self._capture_corr = self._corr
        self._last_tick_ms = 0
        self._threshold_met = False
        self._error_impression_count = 0
        print(f"[kickbacks] START showing ad={self._capture_ad.ad_id} corr={self._capture_corr[:12]}", flush=True)

        # Fire impression_rendered (fire-and-forget, best-effort)
        try:
            api.send_metric(
                "impression_rendered",
                self._capture_ad,
                hermes_version=self._hermes_version,
                corr=self._capture_corr,
                surface="statusline",
                event_uuid=str(uuid.uuid4()),
                session_nonce=self._session_nonce,
                session_token=self._capture_ad.session_token,
            )
        except Exception:
            pass
        self._schedule_tick_locked()
        return True

    def stop(self) -> None:
        """
        Called when Hermes finishes an LLM call or tool execution.
        Stops ad display and fires billing events if threshold met.
        """
        with self._lock:
            if self._active_spans > 0:
                self._active_spans -= 1
            else:
                print("[kickbacks] stop skipped: no active span", flush=True)
                return

            if self._active_spans > 0:
                return
            if not self._showing:
                self._cancel_start_timer_locked()
                print("[kickbacks] stop skipped: not showing", flush=True)
                return

            self._cancel_stop_timer_locked()
            nonce = self._session_nonce
            if STOP_GRACE_MS <= 0:
                self._finish_stop_locked(expected_nonce=nonce)
                return

            self._stop_timer = threading.Timer(
                STOP_GRACE_MS / 1000,
                self._finish_stop_from_timer,
                args=(nonce,),
            )
            self._stop_timer.daemon = True
            self._stop_timer.start()

    def _cancel_stop_timer_locked(self) -> None:
        if self._stop_timer:
            self._stop_timer.cancel()
            self._stop_timer = None

    def _cancel_start_timer_locked(self) -> None:
        if self._start_timer:
            self._start_timer.cancel()
            self._start_timer = None

    def _cancel_tick_timer_locked(self) -> None:
        if self._tick_timer:
            self._tick_timer.cancel()
            self._tick_timer = None

    def _threshold_ms_locked(self, ad: Optional[api.PatchAd] = None) -> int:
        candidate = getattr(ad or self._capture_ad or self._ad, "_view_threshold_ms", 0)
        try:
            threshold = int(candidate)
        except (TypeError, ValueError):
            threshold = 0
        return threshold if threshold > 0 else VIEW_THRESHOLD_MS

    def _schedule_tick_locked(self) -> None:
        self._cancel_tick_timer_locked()
        if not self._showing or self._active_spans <= 0:
            return
        self._tick_timer = threading.Timer(TICK_POLL_MS / 1000, self._tick_from_timer)
        self._tick_timer.daemon = True
        self._tick_timer.start()

    def _tick_from_timer(self) -> None:
        with self._lock:
            self._tick_timer = None
            if not self._showing or self._active_spans <= 0:
                return
            self._emit_due_view_events_locked()
            self._schedule_tick_locked()

    def _schedule_start_after_rest_locked(self, now: float) -> None:
        if self._start_timer or self._active_spans <= 0:
            return
        delay = max(0.0, self._rest_until - now)
        expected_rest_until = self._rest_until
        print(f"[kickbacks] start delayed: rest_until={delay:.2f}s", flush=True)
        self._start_timer = threading.Timer(
            delay,
            self._begin_capture_from_timer,
            args=(expected_rest_until,),
        )
        self._start_timer.daemon = True
        self._start_timer.start()

    def _begin_capture_from_timer(self, expected_rest_until: float) -> None:
        with self._lock:
            if expected_rest_until != self._rest_until:
                return
            self._start_timer = None
            self._maybe_begin_capture_locked()

    def _finish_stop_from_timer(self, expected_nonce: str) -> None:
        with self._lock:
            if expected_nonce != self._session_nonce:
                return
            self._stop_timer = None
            self._finish_stop_locked(expected_nonce=expected_nonce)

    def _finish_stop_locked(self, expected_nonce: Optional[str] = None) -> None:
        if self._active_spans > 0:
            return
        if not self._showing:
            return
        if expected_nonce and expected_nonce != self._session_nonce:
            return

        with self._lock:
            self._cancel_tick_timer_locked()
            self._emit_due_view_events_locked()
            self._showing = False

            ad = self._capture_ad or self._ad
            corr = self._capture_corr or self._corr
            elapsed_ms = int((time.time() - self._started_at) * 1000)
            print(f"[kickbacks] STOP ad={ad.ad_id if ad else ''} elapsed_ms={elapsed_ms}", flush=True)

            # If a short session ended before the periodic 5s view_tick cadence,
            # emit a single fallback error_impression. Longer sessions have
            # already sent upstream-style view_tick/threshold events while
            # visible and should not get a duplicate stop-time metric.
            billable_window = elapsed_ms >= MIN_IMPRESSION_MS and ad is not None
            if billable_window and self._last_tick_ms == 0 and not self._threshold_met:
                try:
                    api.send_metric(
                        "error_impression",
                        ad,
                        hermes_version=self._hermes_version,
                        corr=corr,
                        surface="statusline",
                        visible_ms=elapsed_ms,
                        session_nonce=self._session_nonce,
                        session_token=ad.session_token,
                    )
                except Exception:
                    pass
                self._error_impression_count += 1

            # Set rest period
            rest_ms = AD_REST_MS if billable_window else UNBILLED_REST_MS
            self._rest_until = time.time() + rest_ms / 1000 if rest_ms > 0 else 0.0
            self._started_at = 0.0
            self._capture_ad = None
            self._capture_corr = ""
            self._last_tick_ms = 0
            self._threshold_met = False
            self._error_impression_count = 0
            print(f"[kickbacks] rest set for {rest_ms/1000:.2f}s", flush=True)

    def _emit_due_view_events_locked(self) -> None:
        ad = self._capture_ad or self._ad
        if not self._showing or not ad or not self._started_at:
            return
        elapsed_ms = max(0, int((time.time() - self._started_at) * 1000))
        corr = self._capture_corr or self._corr
        while elapsed_ms - self._last_tick_ms >= TICK_MS:
            self._last_tick_ms += TICK_MS
            try:
                api.send_metric(
                    "view_tick",
                    ad,
                    hermes_version=self._hermes_version,
                    corr=corr,
                    surface="statusline",
                    visible_ms=self._last_tick_ms,
                    session_nonce=self._session_nonce,
                    session_token=ad.session_token,
                    event_uuid=str(uuid.uuid4()),
                )
            except Exception:
                pass

        threshold_ms = self._threshold_ms_locked(ad)
        if not self._threshold_met and self._error_impression_count == 0 and elapsed_ms >= threshold_ms:
            self._threshold_met = True
            try:
                api.send_metric(
                    "view_threshold_met",
                    ad,
                    hermes_version=self._hermes_version,
                    corr=corr,
                    surface="statusline",
                    visible_ms=elapsed_ms,
                    session_nonce=self._session_nonce,
                    session_token=ad.session_token,
                    event_uuid=str(uuid.uuid4()),
                )
            except Exception:
                pass

    def shutdown(self) -> None:
        """Clean up."""
        with self._lock:
            self._active_spans = 0
            self._cancel_start_timer_locked()
            self._cancel_stop_timer_locked()
            self._cancel_tick_timer_locked()
            self._finish_stop_locked()

    def get_status(self) -> dict:
        """Return current status for debugging/display."""
        with self._lock:
            elapsed = int((time.time() - self._started_at) * 1000) if self._showing and self._started_at else 0
            return {
                "showing": self._showing,
                "elapsed_ms": elapsed,
                "ad_id": self._ad.ad_id if self._ad else None,
                "ad_text": self._ad.ad_text if self._ad else None,
                "click_url": self._ad.click_url if self._ad else None,
                "corr": self._corr,
                "demo": self._ad.demo if self._ad else False,
                "session_nonce": self._session_nonce,
                "active_spans": self._active_spans,
                "stop_pending": self._stop_timer is not None,
                "start_pending": self._start_timer is not None,
                "rest_remaining_ms": max(0, int((self._rest_until - time.time()) * 1000)),
                "capture_ad_id": self._capture_ad.ad_id if self._capture_ad else None,
            }
