(function () {
  "use strict";
  // Injected as the first statement of Codex's ThinkingShimmer entry:
  //   function v(e){ e=(<THIS IIFE>)||e; ... }
  // It ALWAYS returns undefined → `e = undefined || e` → Codex's component
  // runs completely untouched. We do NOT swap e.message / return a JSX
  // element: any mutation of (or substitution into) Codex's React-Compiler
  // tree is torn out on the next reconcile (the finnicky no-render). Instead,
  // exactly like the proven Claude Code block, we read Codex's thinking row
  // READ-ONLY and paint the ad in OUR OWN element appended to <body>, OUTSIDE
  // React's roots. Rendering is pure DOM (no network) so it works even though
  // Codex's webview CSP blocks the loopback fetch (telemetry/billing only).
  // Any throw is swallowed and undefined returned — Codex must never break.
  try {
    if (window.__vibeAdsCodexBoot) return undefined;   // one bootstrap / webview
    window.__vibeAdsCodexBoot = 1;
  } catch (e) { return undefined; }
  try {
    var AD = __VIBE_ADS_AD__;
    // Ad identity for the live /ad poll's change detection (see pollAd).
    // Patch-time bake carries no adId; the first poll response fills it in.
    var AD_ID = "";
    var CLICKURL = __VIBE_ADS_CLICKURL__;
    var CLICKTOKEN = __VIBE_ADS_CLICKTOKEN__;
    var CORR = __VIBE_ADS_CORR__, DEBUG = __VIBE_ADS_DEBUG__;
    var PORT = __VIBE_ADS_PORT__, LBTOKEN = __VIBE_ADS_LBTOKEN__;
    var BASE = __VIBE_ADS_BASE__ ||
      ("http://127.0.0.1:" + PORT + "/vibe-ads/" + LBTOKEN);
    var GRACE_MS = 1500;

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }
    function ell(f) { return ["", " .", " ..", " ..."][f % 4]; }
    function elp(ms) { return (ms / 1000).toFixed(1) + "s"; }
    function dlog(evt, data) {
      if (!DEBUG) return;
      try {
        var o = { evt: evt, corr: CORR, t: "codex" };
        if (data) for (var k in data) o[k] = data[k];
        fetch(BASE + "/log", { method: "POST", keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(o) }).catch(function () {});
      } catch (e) {}
    }
    function ping(kind) {
      try {
        fetch(BASE + "/" + kind, { method: "POST", keepalive: true })
          .catch(function () {});
      } catch (e) {}
    }
    function newEventUuid() {
      try {
        if (typeof crypto !== "undefined"
            && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
      } catch (e) { /* fall through */ }
      try {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,
          function (c) {
            var r = Math.random() * 16 | 0;
            var v = c === "x" ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
      } catch (e) { return "evt-" + Date.now() + "-" + Math.random(); }
    }
    dlog("codex.boot", { href: String(location.href).slice(0, 80) });

    // ---- W3 view-time accumulator (mirrors claude-code/block.asset.js) -----
    // An ad must accumulate THRESHOLD_MS of cumulative visible time on the
    // codex_overlay surface before it counts as a billable view. Threshold
    // is server-overridable via /v1/portfolio.view_threshold_seconds, baked
    // into the block as __VIBE_ADS_VIEW_THRESHOLD_MS__ (fallback 15s). Pure
    // best-effort: any throw is swallowed.
    var THRESHOLD_MS = (typeof __VIBE_ADS_VIEW_THRESHOLD_MS__ === "number"
      && __VIBE_ADS_VIEW_THRESHOLD_MS__ > 0)
      ? __VIBE_ADS_VIEW_THRESHOLD_MS__ : 15000;
    var TICK_MS = 5000;
    // MAX_SESSION_MS billing cap. Pinned to THRESHOLD_MS (was a hard 5000)
    // so the 15s `view_threshold_met` fires FIRST and becomes the billing
    // path; the moment it fires the mutex (errorImpressionCount===0 check)
    // suppresses error_impression for the rest of the session. Previously
    // cap(5s) < threshold(15s) forced EVERY codex view down the
    // error_impression path — and because cooldown_view_seconds is also 5s
    // (and the codex block never got the c22c9aa client-side
    // view_tick/error_impression sync), a long-lived or backgrounded codex
    // panel billed a phantom error_impression (tier_error_impression_micros,
    // ~$0.01) roughly every 5s indefinitely, up to the per-user daily cap.
    // With cap===threshold, error_impression is now only a genuine fallback
    // (fires solely if threshold_met somehow didn't). See fixes #1/#3 below.
    var MAX_SESSION_MS = THRESHOLD_MS;
    var SESSION_NONCE = (function () {
      try {
        return (Math.random().toString(36).slice(2)
          + Math.random().toString(36).slice(2)).slice(0, 16);
      } catch (e) { return "s" + Date.now(); }
    })();
    var _vt = Object.create(null);
    function vtKey(adId, surface) { return surface + ":" + adId; }
    function viewShow(adId, surface) {
      if (!adId) return;
      var k = vtKey(adId, surface);
      var s = _vt[k];
      if (!s) {
        // Sticky sessionStartedAt — repeat viewShow() with same nonce does
        // NOT restart the baseline. `paused`/`pausedAt` carry fix #3 (freeze
        // while the webview is hidden). The session is ENDED (not merely
        // hidden) when the overlay drops at idle — see viewEnd / dropOverlay.
        _vt[k] = { adId: adId, surface: surface,
          sessionNonce: SESSION_NONCE,
          sessionStartedAt: Date.now(),
          lastTickMs: 0, thresholdMet: false,
          errorImpressionCount: 0,
          paused: false, pausedAt: 0 };
      }
    }
    // Fix #1: END a view session outright (used when the overlay drops at
    // idle). The old viewHide was a no-op, so once viewShow created a session
    // the 250ms viewTick kept accumulating elapsed time FOREVER — even after
    // the ad left the screen — which is exactly the 31-minute "stuck" codex
    // session that spammed error_impression. Removing the record stops the
    // accumulator; a later paint() calls viewShow() again for a FRESH session.
    function viewEnd(adId, surface) {
      try { delete _vt[vtKey(adId, surface)]; } catch (e) {}
    }
    function viewHide(_adId, _surface) {
      // No-op kept for call-site compatibility; real teardown is viewEnd().
    }
    function viewMaybeEmit(s) {
      // Fix #3: a hidden Codex webview must NOT accrue view-time. (The Claude
      // adapter deliberately keeps counting when hidden under its absolute-
      // epoch model; Codex does the opposite — a backgrounded panel was the
      // other half of the phantom-billing loop.) While document.hidden we
      // freeze: mark paused (stamping pausedAt once) and emit nothing. On the
      // next visible poll we shift sessionStartedAt forward by the hidden gap
      // so off-screen time is excluded from elapsed, then resume mid-session
      // (lastTickMs / errorImpressionCount untouched, so cadence continues).
      var hidden = false;
      try { hidden = (typeof document.hidden === "boolean") && document.hidden; }
      catch (e) { hidden = false; }
      if (hidden) {
        if (!s.paused) { s.paused = true; s.pausedAt = Date.now(); }
        return;
      }
      if (s.paused) {
        s.sessionStartedAt += Math.max(0, Date.now() - (s.pausedAt || Date.now()));
        s.paused = false; s.pausedAt = 0;
      }
      var elapsed = Math.max(0, Date.now() - s.sessionStartedAt);
      var tickFired = false;
      while (elapsed - s.lastTickMs >= TICK_MS) {
        s.lastTickMs += TICK_MS;
        tickFired = true;
        var tickEventUuid = newEventUuid();
        var q = "?surface=" + encodeURIComponent(s.surface)
          + "&ad=" + encodeURIComponent(s.adId)
          + "&visible_ms=" + s.lastTickMs
          + "&session=" + encodeURIComponent(s.sessionNonce)
          + "&event_uuid=" + encodeURIComponent(tickEventUuid);
        ping("view_tick" + q);
      }
      // Mutex: threshold_met fires once per session, and only when no
      // error_impression has fired yet. With cap===threshold (fix #2) the
      // threshold check runs first at elapsed>=THRESHOLD_MS and wins, so
      // threshold_met is now the PRIMARY billing path for codex (it used to
      // never fire because the 5s cap tripped error_impression first).
      if (!s.thresholdMet && s.errorImpressionCount === 0
          && elapsed >= THRESHOLD_MS) {
        s.thresholdMet = true;
        var thresholdEventUuid = newEventUuid();
        var q2 = "?surface=" + encodeURIComponent(s.surface)
          + "&ad=" + encodeURIComponent(s.adId)
          + "&visible_ms=" + elapsed
          + "&threshold_ms=" + THRESHOLD_MS
          + "&session=" + encodeURIComponent(s.sessionNonce)
          + "&event_uuid=" + encodeURIComponent(thresholdEventUuid);
        dlog("codex.view.threshold_met", { adId: s.adId, surface: s.surface,
          visibleMs: elapsed, eventUuid: thresholdEventUuid });
        ping("view_threshold_met" + q2);
      }
      var nextFireAt = (s.errorImpressionCount + 1) * MAX_SESSION_MS;
      if (!tickFired && !s.thresholdMet && elapsed >= nextFireAt) {
        s.errorImpressionCount += 1;
        var errorEventUuid = newEventUuid();
        var q3 = "?surface=" + encodeURIComponent(s.surface)
          + "&ad=" + encodeURIComponent(s.adId)
          + "&visible_ms=" + elapsed
          + "&max_session_ms=" + MAX_SESSION_MS
          + "&fire=" + s.errorImpressionCount
          + "&session=" + encodeURIComponent(s.sessionNonce)
          + "&event_uuid=" + encodeURIComponent(errorEventUuid);
        dlog("codex.view.error_impression", { adId: s.adId,
          surface: s.surface, visibleMs: elapsed,
          fire: s.errorImpressionCount, eventUuid: errorEventUuid });
        ping("error_impression" + q3);
      }
    }
    function viewTick() {
      try {
        for (var k in _vt) viewMaybeEmit(_vt[k]);
      } catch (e) {}
    }
    setInterval(viewTick, 250);
    // Click-threshold companion: snapshot the running visible_ms for an
    // ad+surface so the extension loopback can apply a floor (clicks
    // before X ms of cumulative visible time get logged but not billed).
    function viewVisibleMsNow(adId, surface) {
      try {
        var s = _vt[vtKey(adId, surface)];
        if (!s) return 0;
        return Math.max(0, Date.now() - s.sessionStartedAt);
      } catch (e) { return 0; }
    }
    // Hidden-webview accounting (fix #3): unlike the Claude adapter, a hidden
    // Codex panel does NOT keep counting — viewMaybeEmit pauses the
    // accumulator while document.hidden is true and resumes (shifting the
    // baseline past the hidden gap) when it's shown again. The 250ms poll
    // observes the visibility flip within a tick, so no separate
    // visibilitychange listener is needed.

    var FG = "var(--vscode-foreground,currentColor)";
    var DIM = "var(--vscode-descriptionForeground,currentColor)";
    var FAV = '<svg width="13" height="13" viewBox="0 0 13 13" ' +
      'aria-hidden="true" style="vertical-align:middle;border-radius:3px;' +
      'flex:0 0 auto"><rect width="13" height="13" rx="3" fill="#188a45"/>' +
      '<text x="6.5" y="9.6" font-size="9" font-family="monospace" ' +
      'font-weight="700" text-anchor="middle" fill="#fff">K</text></svg>';
    function buildAd(dots, elapsed) {
      var href = /^https?:\/\//i.test(CLICKURL || "") ? esc(CLICKURL) : "#";
      // Favicon lives INSIDE the anchor (matches CC's adapter shape) so a
      // probe like `[data-vibe-ads-ad] svg` finds it — the row 08 / 09
      // adHasFavicon check used to fail because the SVG was a sibling of
      // the anchor, not a descendant. Visual is unchanged: favicon stays
      // immediately left of the ad text, just now part of the link
      // (clicking the favicon now navigates, which is the desired UX).
      var A = '<a href="' + href + '" target="_blank" rel="noopener noreferrer" ' +
        'data-vibe-ads-ad="1" style="display:inline-flex;align-items:center;' +
        'gap:7px;color:' + FG +
        ';text-decoration:underline;overflow:hidden;text-overflow:ellipsis">' +
        FAV + esc(AD) + '<span style="display:inline-block;width:3ch;' +
        'text-align:left;white-space:pre">' + esc(dots) + "</span></a>";
      var left = '<span style="display:flex;align-items:center;gap:7px;' +
        'color:' + FG + ';min-width:0">' + A + "</span>";
      var right = '<span style="font-size:11px;color:' + DIM +
        ';flex:0 0 auto;margin-left:auto;padding-left:24px;' +
        'font-var' + String.fromCharCode(105, 97, 110, 116) + '-numeric:tabular-nums">' + esc(elapsed) + "</span>";
      return '<span style="display:flex;align-items:center;width:100%;' +
        'box-sizing:border-box;padding:0 4px;justify-content:flex-start;' +
        'white-space:nowrap">' + left + right + "</span>";
    }

    // Locate Codex's thinking-shimmer line READ-ONLY. The entry component `v`
    // renders its text span with the stable class combo
    // `text-size-chat … select-none truncate` (from the chunk:
    // o=s("text-size-chat leading-[1.5] select-none truncate", className)).
    // Require ALL THREE tokens so nothing else in the chat ever matches —
    // and since we only READ its rect (never mutate it) a mis-match is at
    // worst a cosmetic mispaint, never a prime-directive violation.
    //
    // ALSO require `loading-shimmer` (the live sweep marker) and a non-zero
    // bounding rect. Codex 26.x keeps the post-turn "Thinking 1.2s" summary
    // chip in the chat history with the SAME `text-size-chat truncate
    // select-none` class combo and textContent "Thinking 1.2s", but as a
    // display:none / hidden element — it does NOT carry `loading-shimmer-*`.
    // Without the extra anchors the old predicate matched the static history
    // chip and `isThinkingRow()` returned true forever — overlay never
    // released at idle (row 03 regression) and stuck to turn 1 on multi-
    // turn prompts (row 08, "glued to turn 1").
    function findRow() {
      var els = document.querySelectorAll(
        '[class*="text-size-chat"][class*="truncate"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.nodeType !== 1) continue;
        var c = " " + (el.className || "") + " ";
        if (c.indexOf("select-none") === -1) continue;
        if (c.indexOf("loading-shimmer") === -1) continue;
        var r = el.getBoundingClientRect && el.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) continue;
        // Honour visibility / opacity. Codex 26.x keeps the live shimmer
        // element mounted briefly with `visibility:hidden` between the
        // text-stream-end and the React unmount, so the row is technically
        // present (rect non-zero, class trio still on) but invisible —
        // exactly the post-stream state row 03 / codexBusy treat as
        // "idle." Without this guard the overlay keeps painting on a
        // hidden shimmer and isAnimating() catches our dot-cycle frames.
        try {
          var cs = window.getComputedStyle && window.getComputedStyle(el);
          if (cs) {
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            if (parseFloat(cs.opacity || "1") < 0.05) continue;
          }
        } catch (e) { /* jsdom / detached frame: fall through, pass */ }
        return el;
      }
      return null;
    }
    // §4.4 gate, DOM-driven: show ONLY when the row is Codex's GENERIC
    // "Thinking" placeholder. A real tool/approval/reasoning status renders
    // different text (e.g. "Reading …", "Running …") → we yield (no overlay).
    //
    // Codex 26.x renders the shimmer as TWO stacked spans (base + sweep
    // highlight overlay) so textContent concatenates to "ThinkingThinking".
    // The previous /^thinking\b/i predicate failed against that string
    // because `\b` requires a non-word char after "thinking" and the next
    // char (`T`) is a word char — that was the regression causing rows
    // 02 / 08 / 09 sawAd:false. Drop the word-boundary and rely on the
    // length cap + the class-trio anchor in findRow().
    function isThinkingRow(el) {
      if (!el) return false;
      var t = (el.textContent || "").trim();
      // Empty was previously treated as "shimmer mounted, text incoming"
      // but it's ALSO the post-completion state where Codex unmounts
      // the text but leaves the wrapper span. That ambiguity made the
      // ad linger past streaming (row 03 idle-release regression).
      // Require an explicit "thinking" prefix; the transient empty
      // window is brief enough that the GRACE_MS=1500 idle timer
      // handles re-paint on subsequent turns without leaking idle paint.
      if (!t) return false;
      // accept "Thinking", "ThinkingThinking" (duplicated-span case),
      // "Thinking…", "Thinking 1.2s" — all start with "thinking".
      var lc = t.toLowerCase();
      return lc.length <= 32 && lc.indexOf("thinking") === 0;
    }
    function surfaceBg(el) {
      // The overlay sits on top of the "Thinking" row, so a transparent
      // bg would let the underlying verb text bleed through. We need a
      // colour, and it must match the surrounding chat-panel surface.
      // The old strategy (first non-transparent ancestor) grabbed
      // intermediate wrappers — chat bubble surfaces, hover tints —
      // which differ in shade from the visible panel and made the ad
      // look like a patch. Preferred chain:
      //   1. nearest SCROLLABLE ancestor's bg (== the visible panel)
      //   2. document.body's computed bg (== VS Code's webview theme)
      //   3. CSS var fallback (theme-aware even when computed values
      //      aren't resolvable, e.g. detached frames)
      try {
        var n = el, hops = 0;
        while (n && n.nodeType === 1 && hops++ < 20) {
          var cs = window.getComputedStyle(n) || {};
          var ov = cs.overflowY || cs.overflow;
          if (ov === "auto" || ov === "scroll") {
            var bg = cs.backgroundColor;
            if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)")
              return bg;
            break;          // found the panel; its bg is transparent
          }
          n = n.parentElement;
        }
        var bodyBg = (window.getComputedStyle(document.body) || {})
          .backgroundColor;
        if (bodyBg && bodyBg !== "transparent"
          && bodyBg !== "rgba(0, 0, 0, 0)") return bodyBg;
      } catch (e) {}
      return "var(--vscode-sideBar-background,"
        + "var(--vscode-editor-background,#1e1e1e))";
    }

    // Click-out: the anchor's real http(s) href is what the VS Code webview
    // host opens externally (CSP-exempt) — the only click that survives
    // Codex's `default-src 'none'`. Do NOT preventDefault. The ping is
    // best-effort billing (revived by the Codex connect-src patch).
    document.addEventListener("click", function (ev) {
      var el = ev.target;
      while (el && el !== document) {
        if (el.getAttribute && el.getAttribute("data-vibe-ads-ad")) {
          var vms = viewVisibleMsNow(AD, "codex_overlay");
          var clickEventUuid = newEventUuid();
          dlog("codex.click", { ct: CLICKTOKEN, visibleMs: vms,
            eventUuid: clickEventUuid });
          // `ad=` is the attribution CLAIM (parity with the CC block): the
          // host's recent-ads registry resolves a click that lands during
          // the ≤10s /ad poll lag after a rotation to the creative actually
          // on screen instead of the freshly-rotated one.
          ping("click?ct=" + encodeURIComponent(CLICKTOKEN) +
            "&corr=" + encodeURIComponent(CORR) +
            "&surface=codex_overlay" +
            "&visible_ms=" + vms +
            "&ad=" + encodeURIComponent(AD) +
            "&event_uuid=" + encodeURIComponent(clickEventUuid));
          return;
        }
        el = el.parentNode;
      }
    }, true);

    var overlay = null, lastRow = null, lastSeenMs = 0, _rect = "";
    var t0 = 0, frameN = 0, _shown = false, _sent = false;
    function ensureOverlay(row) {
      if (overlay && overlay.parentNode) return overlay;
      overlay = document.createElement("div");
      overlay.setAttribute("data-vibe-ads", "codex");
      overlay.style.cssText =
        "position:fixed;z-index:2147483646;pointer-events:auto;" +
        "display:flex;align-items:center;box-sizing:border-box;" +
        "overflow:hidden;white-space:nowrap;visibility:hidden;background:" +
        surfaceBg(row);
      try { (document.body || document.documentElement).appendChild(overlay); }
      catch (e) {}
      return overlay;
    }
    function placeOverlay(row) {
      try {
        var r = row.getBoundingClientRect();
        if (r && (r.width || r.height || r.top || r.left)) {
          var key = r.left + "," + r.top + "," + r.width + "," + r.height;
          if (key !== _rect) {
            _rect = key;
            overlay.style.left = r.left + "px";
            overlay.style.top = r.top + "px";
            overlay.style.minWidth = r.width + "px";
            overlay.style.height = r.height + "px";
            overlay.style.visibility = "visible";
          }
        }
      } catch (e) {}
    }
    function dropOverlay() {
      // Fix #1: END the view session (was a no-op viewHide) so the
      // accumulator stops the instant the ad leaves the screen at idle,
      // instead of ticking off-screen forever. _sent reset below means the
      // next turn opens a fresh impression session.
      try { viewEnd(AD, "codex_overlay"); } catch (e) {}
      try { if (overlay && overlay.parentNode)
        overlay.parentNode.removeChild(overlay); } catch (e) {}
      overlay = null; lastRow = null; _rect = ""; _shown = false; _sent = false;
    }
    function paint(row) {
      var now = Date.now();
      if (!t0) t0 = now;
      lastRow = row; lastSeenMs = now;
      frameN++;
      if (!_shown) { _shown = true;
        dlog("codex.show", { cls: String(row.className || "").slice(0, 60) }); }
      if (!_sent) { _sent = true;
        ping("impression_rendered?surface=codex_overlay&ad="
          + encodeURIComponent(AD)
          + "&event_uuid=" + encodeURIComponent(newEventUuid()));
        var vis = (typeof document.hidden === "undefined")
          ? true : !document.hidden;
        if (vis) {
          ping("impression_viewable?surface=codex_overlay&ad="
            + encodeURIComponent(AD)
            + "&event_uuid=" + encodeURIComponent(newEventUuid()));
        }
      }
      try { viewShow(AD, "codex_overlay"); } catch (e) {}
      var o = ensureOverlay(row);
      placeOverlay(row);
      var html = buildAd(ell(Math.floor(frameN / 3)), elp(now - t0));
      if (o.innerHTML !== html) o.innerHTML = html;     // OUR node only
    }
    function frame() {
      try {
        if (overlay && lastRow && lastRow.isConnected) placeOverlay(lastRow);
      } catch (e) {}
      try { window.requestAnimationFrame(frame); }
      catch (e) { setTimeout(frame, 16); }
    }
    try { window.requestAnimationFrame(frame); }
    catch (e) { setTimeout(frame, 16); }

    // ---- Live ad refresh (parity with claude-code/block.asset.js pollAd) --
    // The baked __VIBE_ADS_AD__ used to be FROZEN for the life of the webview:
    // rotation re-patched the bundle on disk but a running Codex panel never
    // re-read it, so users sat on one creative — or the pre-inventory
    // "Your ad here" placeholder — until a full reload (the "frozen ads on
    // codex" complaint, 2026-06-11). Poll the loopback /ad every 10s:
    //   • changed payload  → adopt AD/AD_ID/CLICKURL and RESET all view-time
    //     sessions + impression flags, so the old creative's accumulated time
    //     never bills against the new one (fresh session, fresh threshold).
    //   • successful-but-EMPTY payload ×2 (debounced, same as CC) → the
    //     host's no-serve signal (kill / disable / sign-out): drop the
    //     overlay, end every session, and suppress repaint until served.
    //   • fetch ERROR → keep the last ad (transient network / CSP without the
    //     connect-src patch — identical to today's behavior, no regression).
    var _adEmptyPolls = 0, _noServe = false;
    function pollAd() {
      try {
        fetch(BASE + "/ad").then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.adText) {
              _adEmptyPolls++;
              if (_adEmptyPolls >= 2 && !_noServe) {
                _noServe = true;
                dlog("codex.no_serve", { polls: _adEmptyPolls });
                // End EVERY session (not just the current key) before the
                // drop: billing must stop with the serve, unconditionally.
                _vt = Object.create(null);
                dropOverlay(); t0 = 0; frameN = 0;
              }
              return;
            }
            _adEmptyPolls = 0;
            if (_noServe) {
              // Host resumed serving (possibly the same creative): re-arm.
              // The overlay re-mounts on the next active 80ms tick.
              _noServe = false;
              dlog("codex.serve_resume", { adId: j.adId });
            }
            var changed = (j.adId && j.adId !== AD_ID) || (j.adText !== AD)
              || ((j.clickUrl || "") !== CLICKURL);
            if (!changed) return;
            dlog("codex.ad_rotated",
              { fromId: AD_ID, toId: j.adId, from: AD, to: j.adText });
            AD_ID = j.adId || AD_ID;
            AD = j.adText;
            CLICKURL = j.clickUrl || "";
            // Billing fairness on swap: end the old creative's sessions and
            // re-arm the impression events — the next paint() opens a FRESH
            // session for the new ad (viewShow keys on the ad text) and
            // fires impression_rendered/viewable for it. paint()'s
            // innerHTML-diff repaints the overlay with the new creative on
            // the next 80ms tick (codex rewrites it every dot-frame anyway).
            _vt = Object.create(null);
            _sent = false; _shown = false;
          }).catch(function () {
            // Fetch ERROR: keep the last ad — deliberately NOT no-serve.
          });
      } catch (e) { /* prime directive */ }
    }
    setInterval(pollAd, 10000);
    // One early poll so a patch-time placeholder ("Your ad here") or a
    // rotation that landed between patch and boot is replaced within ~5s.
    setTimeout(pollAd, 5000);

    setInterval(function () {
      try {
        var now = Date.now();
        var row = findRow();
        if (!_noServe && row && isThinkingRow(row)) {
          paint(row);
        } else if (overlay && (now - lastSeenMs) > GRACE_MS) {
          dlog("codex.idle", { sinceMs: now - lastSeenMs });
          dropOverlay(); t0 = 0; frameN = 0;
        }
      } catch (e) {
        dlog("codex.looperr",
          { msg: String(e && e.message || e).slice(0, 160) });
      }
    }, 80);
  } catch (__vibeads) {
    try {
      var D = __VIBE_ADS_DEBUG__, C = __VIBE_ADS_CORR__,
        B = __VIBE_ADS_BASE__ || ("http://127.0.0.1:" + __VIBE_ADS_PORT__ +
          "/vibe-ads/" + __VIBE_ADS_LBTOKEN__);
      if (D) fetch(B + "/log", { method: "POST", keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evt: "codex.throw", corr: C, t: "codex",
          msg: String(__vibeads && __vibeads.message || __vibeads)
            .slice(0, 140) }) }).catch(function () {});
    } catch (e) {}
  }
  return undefined;                 // ALWAYS — Codex's component untouched
})()
