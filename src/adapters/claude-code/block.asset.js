/* VIBE-ADS-START */
(function () {
  "use strict";
  var TIER = __VIBE_ADS_TIER__;
  var AD = __VIBE_ADS_AD__;
  var ICON_REF = __VIBE_ADS_ICON__;
  var ICON_URL = __VIBE_ADS_ICON_URL__;
  var PORT = __VIBE_ADS_PORT__;
  var LBTOKEN = __VIBE_ADS_LBTOKEN__;
  var CLICKTOKEN = __VIBE_ADS_CLICKTOKEN__;
  // Advertiser landing URL, rendered as the anchor's REAL href. Claude Code's
  // webview ships `default-src 'none'` with no connect-src, so an in-page
  // fetch/beacon to the loopback is CSP-blocked and postMessage only reaches
  // CC's own extension (not ours). A genuine http(s) href is the one click-out
  // that survives: the VS Code webview host itself opens it externally. The
  // loopback /click ping below is now ONLY the (best-effort) billing metric.
  var CLICKURL = __VIBE_ADS_CLICKURL__;
  // When true the injected block also renders the ad in the usage-limit banner
  // (mirror of the spinner ad; spec §3). False => no DOM scanning at all.
  var BANNER_ON = __VIBE_ADS_BANNER_ON__;
  // Correlation id (patch-time minted). Carried on the /click ping and every
  // relayed dlog line so the merged debug stream is greppable end-to-end.
  var CORR = __VIBE_ADS_CORR__;
  var AD_ID = CORR.substring(0, CORR.lastIndexOf("."));
  // Resolved by the extension via vscode.env.asExternalUri so the webview can
  // reach the loopback on VS Code Remote/Server (raw 127.0.0.1 there is the
  // CLIENT, not the extension host). Falls back to local 127.0.0.1.
  var BASE = __VIBE_ADS_BASE__ || ("http://127.0.0.1:" + PORT + "/vibe-ads/" + LBTOKEN);
  function fmtElapsed(ms) { return (ms / 1000).toFixed(1) + "s"; }
  // 0..5 dots (6 frames). Advance is slowed via the render-loop cadence.
  function ellipsis(frame) {
    return ["", " .", " ..", " ...", " ....", " ....."][frame % 6];
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  // --- Usage-banner ad: banner locator -----------------------------------
  // The orange weekly/usage-limit banner ("You've used 71% of your weekly
  // limit · resets in 4d · View usage") is server-data-rendered, so there is
  // no static array literal to Tier-0 swap — the only lever is a DOM rewrite
  // from this injected block, exactly like the spinner. This predicate is the
  // locator anchor: it must be specific enough that NOTHING else in the chat
  // webview ever matches (rewriting unrelated chrome would be a prime-directive
  // violation). Require BOTH a usage-percentage clause AND a reset clause —
  // either one alone is too generic (docs/prose can say "resets in …").
  function looksLikeUsageBanner(text) {
    var t = String(text || "");
    if (!t) return false;
    var hasLimit = /\b\d{1,3}%\s+of your\b[^]*\b(?:weekly|usage)\s+limit\b/i.test(t);
    var hasReset = /\bresets?\s+in\s+\d/i.test(t);
    return hasLimit && hasReset;
  }
  var FAVICON_FALLBACK =
    '<svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" ' +
    'style="vertical-align:middle;border-radius:3px;flex:0 0 auto">' +
    '<rect width="13" height="13" rx="3" fill="#188a45"/>' +
    '<text x="6.5" y="9.6" font-size="9" font-family="monospace" ' +
    'font-weight="700" text-anchor="middle" fill="#fff">K</text></svg>';
  // The ad-icon <img>. Tagged data-va-icon="1" so the capture-phase error
  // listener (see init) can swap it for the inline 'K' SVG if the image fails
  // to load — covers a blocked/404 icon. NB the swap MUST be wired
  // programmatically: CC's webview CSP is script-src 'nonce-...' with no
  // 'unsafe-inline', so an inline onerror="" attribute would itself be blocked.
  function faviconImg(url) {
    return '<img src="' + esc(url) + '" width="13" height="13" ' +
      'data-va-icon="1" aria-hidden="true" ' +
      'style="vertical-align:middle;border-radius:3px;' +
      'flex:0 0 auto;display:block;object-fit:contain" />';
  }
  var FAVICON = ICON_URL ? faviconImg(ICON_URL) : FAVICON_FALLBACK;

  // The block renders ONLY the ad, and ONLY while a turn is active. There is
  // no done-state and no Continue CTA (removed): when Claude Code is idle the
  // block does nothing and leaves the last rendered frame in place (the render
  // loop simply stops clobbering it).
  function buildAdHtml(tier, s) {
    var ad = esc(s.ad), dots = esc(s.dots || "");
    // Real navigable href (the VS Code host opens http(s) externally on click,
    // bypassing the webview CSP). `target=_blank rel=noopener` is belt-and-
    // suspenders; falls back to "#" only when no URL was supplied (tests).
    var href = s.href ? esc(s.href) : "#";
    // text-decoration:underline => the ad reads as the clickable hyperlink it
    // is (was `none`, looked like inert label text).
    var A1 = '<a href="' + href + '" target="_blank" ' +
      'rel="noopener noreferrer" data-vibe-ads-ad="1" style="color:';
    var FG = "var(--vscode-foreground,currentColor)";
    var DIM = "var(--vscode-descriptionForeground,currentColor)";
    // Animated dots live in a FIXED-WIDTH slot so their changing length
    // can't reflow the left block and shove the right-hand timer around.
    // Monospace-ish + width reserved for the longest.
    var DOTS = '<span data-va-dots="1" style="display:inline-block;width:3ch;'
      + 'text-align:left;white-space:pre">' + dots + "</span>";
    var anchor = A1 + FG + ';text-decoration:underline">' + ad + DOTS + "</a>";
    if (tier <= 1) return anchor;
    var fav = (tier >= 3) ? FAVICON : "";
    var left = '<span style="display:flex;align-items:center;gap:7px;color:' +
      FG + ';min-width:0">' + fav + A1 + FG +
      ';text-decoration:underline;overflow:hidden;text-overflow:ellipsis">' +
      ad + DOTS + "</a></span>";
    // Right segment PINNED to the right edge (margin-left:auto) and rendered
    // in a tabular monospace so digit-count changes (0.9s→1.2s) don't jitter.
    var rt = esc(s.elapsed || "");
    var right = '<span data-va-elapsed="1" style="font-size:11px;color:' + DIM +
      ';flex:0 0 auto;margin-left:auto;padding-left:24px;' +
      'font-family:var(--vscode-editor-font-family,ui-monospace,monospace);' +
      'font-var' + String.fromCharCode(105, 97, 110, 116) + '-numeric:tabular-nums">' + rt + "</span>";
    // Left-justified favicon+ad (hugs the left edge); the timer is pinned
    // right via margin-left:auto. box-sizing:border-box so the padding
    // insets without 100% width overflowing the row.
    return '<span style="display:flex;align-items:center;width:100%;' +
      'box-sizing:border-box;padding:0 32px;' +
      'justify-content:flex-start;white-space:nowrap">' + left + right +
      "</span>";
  }

  // Usage-banner ad: a single-line clickable anchor mirroring the spinner
  // creative. data-vibe-ads-ad="1" reuses the existing capture-phase click
  // listener (no new click plumbing). Pure; unit-tested via module.exports.
  function buildBannerHtml(ad, clickUrl) {
    var href = /^https?:\/\//i.test(clickUrl || "") ? esc(clickUrl) : "#";
    var FG = "var(--vscode-foreground,currentColor)";
    // Wrap favicon+anchor in our own left-justified inline-flex so CC's
    // banner container styling can't fling the text to the far right away
    // from the logo; underline marks it as the clickable link it is.
    return '<span style="display:inline-flex;align-items:center;gap:6px;' +
      'justify-content:flex-start">' + FAVICON +
      '<a href="' + href + '" target="_blank" rel="noopener noreferrer" ' +
      'data-vibe-ads-ad="1" style="color:' + FG +
      ';text-decoration:underline">' + esc(ad) + "</a></span>";
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { fmtElapsed: fmtElapsed, ellipsis: ellipsis, esc: esc,
      buildAdHtml: buildAdHtml, looksLikeUsageBanner: looksLikeUsageBanner,
      buildBannerHtml: buildBannerHtml };
    return;
  }

  try {
    var st = { simStart: Date.now(), frame: 0, sentRender: false,
               wasVisible: false };
    // (Verb is now located by CC's `spinnerRow_` container class, telemetry-
    // confirmed — NOT a glyph heuristic. The old glyph-prefix scan matched
    // Monaco editor / **markdown** spans and clobbered the user's document,
    // a prime-directive violation; class-scoping makes that impossible.)
    var realAct = null;
    // Cached refs to the volatile children of the overlay's anchor/right
    // span. paint() updates only their textContent on the hot path so the
    // anchor element itself is NEVER detached between mousedown/mouseup —
    // the previous innerHTML-every-tick rewrite (~12×/sec) was racing the
    // user's click and silently dropping it. Cleared on dropOverlay; refilled
    // on a structural rebuild.
    var _chromeSig = "", _dotsEl = null, _elapsedEl = null;
    // Verb-pinned clobber model. The ad is written into Claude Code's OWN
    // verb element; an observer replaces freshly-mounted verb nodes pre-paint
    // (no flicker). A node is identified as the verb PURELY by current
    // glyph-led content (NOT by an attribute) — an attribute marker poisoned
    // the node forever once CC re-rendered its verb back into the same
    // element in place, which is why the ad vanished mid-thinking and never
    // returned. GRACE_MS bridges the (sometimes >1s) gaps between CC's
    // intra-turn verb re-renders; only after a real GRACE of no verb at all
    // do we clear (matches the long-proven loop). `verb.dom` dlog captures
    // the real CC verb DOM (identity reuse / gap timings / structure) so the
    // pin can be tightened from evidence next session.
    var lastNode = null, lastSeenMs = 0;
    // Idle debounce: how long the spinner may be stale before we drop the
    // overlay. Empirically (e2e DOM dumps, CC 2.1.143): while thinking CC
    // re-renders spinnerRow every animation frame so its textContent CHANGES
    // continuously; at turn end CC empties spinnerRow to `<div></div>` but
    // leaves the `.spinnerRow_` node mounted, and can leave a STALE prior node
    // frozen mid-glyph. Glyph PRESENCE is therefore NOT a liveness signal — a
    // frozen stale node kept rowActive() true forever, so paint() kept
    // refreshing lastSeenMs and the ad animated at idle indefinitely (the
    // row-03 regression, and why _spinnerActive never cleared so the banner
    // ad never un-hid). The true signal is content FRESHNESS: active ==
    // glyph-led AND the spinner content changed within GRACE_MS.
    var GRACE_MS = 1500;
    // Freshness: signature of the live spinner content + when it last
    // changed. A frozen/stale node's signature never changes => idle after
    // GRACE_MS even though a glyph char is still present.
    var lastSig = null, lastSigMs = 0;
    var _foundLogged = false, _shown = false;
    var _verbSeq = 0, _lastVerbEl = null, _lastVerbMs = 0;

    var DEBUG = __VIBE_ADS_DEBUG__;
    var _seq = 0, _dlogFails = 0;
    // Relay a timestamped lifecycle line to the loopback (→ server-side
    // ~/.vibe-ads/debug.log) so a headless agent can diagnose without a
    // screen. Gated; never disturbs the spinner. The first line arriving at
    // all is itself the proof the loopback is reachable on Remote.
    function dlog(evt, data) {
      if (!DEBUG) return;
      try {
        var o = { n: ++_seq, evt: evt, corr: CORR };
        if (data) for (var k in data) o[k] = data[k];
        fetch(BASE + "/log", { method: "POST", keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(o) }).catch(function () { _dlogFails++; });
      } catch (e) { _dlogFails++; }
    }
    function ping(kind) {
      // Click pings have to race the VS Code webview host's external-
      // navigation on the same tick: the moment the anchor's href fires,
      // the document may be torn down. fetch+keepalive often makes it
      // out, but sendBeacon was designed for exactly this lifecycle
      // ("send this beacon during unload, browser, please") and is the
      // most reliable path across Electron versions. Try sendBeacon
      // first; fall back to fetch+keepalive if unavailable or rejected.
      try {
        var url = BASE + "/" + kind;
        var sent = false;
        try {
          if (navigator && typeof navigator.sendBeacon === "function") {
            sent = navigator.sendBeacon(url, new Blob([],
              { type: "application/x-www-form-urlencoded" }));
            if (sent) dlog("ping.ok", { kind: kind, via: "beacon" });
          }
        } catch (e) { sent = false; }
        if (sent) return;
        fetch(url, { method: "POST", keepalive: true })
          .then(function () { dlog("ping.ok", { kind: kind, via: "fetch" }); })
          .catch(function () { dlog("ping.fail", { kind: kind, via: "fetch" }); });
      } catch (e) { /* metrics best-effort; never affect the spinner */ }
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

    // ---- W3 view-time accumulator (absolute-epoch baseline) -------------
    // An ad session's elapsed time is computed as `Date.now() -
    // sessionStartedAt` on every 250 ms poll. No accumulator, no
    // pause-on-hide. Rationale: the prior accumulator-with-pause model
    // dropped time whenever setInterval skipped a tick (throttled tab,
    // CPU pressure, the webview backgrounded) and produced "stuck session
    // never bills" log signatures. Absolute wall clock is immune to poll
    // cadence drift, at the cost of counting time while the webview is
    // hidden — bounded in practice by the threshold-met/error_impression
    // mutex (one bill per session) plus the server-side cooldown gate.
    // Threshold is server-overridable via /v1/portfolio.view_threshold_seconds
    // (baked into the block as __VIBE_ADS_VIEW_THRESHOLD_MS__; falls back
    // to 15_000 ms when the server didn't specify). Pure best-effort:
    // any throw is swallowed (prime directive).
    var THRESHOLD_MS = (typeof __VIBE_ADS_VIEW_THRESHOLD_MS__ === "number"
      && __VIBE_ADS_VIEW_THRESHOLD_MS__ > 0)
      ? __VIBE_ADS_VIEW_THRESHOLD_MS__ : 15000;
    var TICK_MS = 5000;
    // MAX_SESSION_MS billing cap: fire `error_impression` at EVERY
    // multiple of this elapsed mark. Default 5 s, so a 30 s stuck
    // session fires 6 events. The backend cooldown gate decides which
    // of those actually credit; with the matching 5 s cooldown default
    // every fire credits. threshold_met is suppressed once any
    // error_impression has fired this session (preserves the codex-
    // rescue "one billing path per session" mutex while allowing the
    // billing path itself to repeat).
    var MAX_SESSION_MS = 5000;
    var SESSION_NONCE = (function () {
      try {
        return (Math.random().toString(36).slice(2)
          + Math.random().toString(36).slice(2)).slice(0, 16);
      } catch (e) { return "s" + Date.now(); }
    })();
    var _vt = Object.create(null);  // key "surface:adId" -> session record
    function vtKey(adId, surface) { return surface + ":" + adId; }
    function viewShow(adId, surface) {
      if (!adId) return;
      var k = vtKey(adId, surface);
      var s = _vt[k];
      if (!s) {
        // sessionStartedAt is set ONCE on session creation and is sticky
        // for the lifetime of (adId, surface, sessionNonce). Subsequent
        // viewShow() calls with the same nonce do NOT restart it.
        // errorImpressionCount tracks how many error_impressions have
        // fired so far; the next one fires at (count+1)*MAX_SESSION_MS.
        _vt[k] = { adId: adId, surface: surface,
          sessionNonce: SESSION_NONCE,
          sessionStartedAt: Date.now(),
          lastTickMs: 0, thresholdMet: false,
          errorImpressionCount: 0,
          // PERSIST-AT-IDLE billing pause. While `paused` no events emit
          // and elapsed is frozen at `pausedAt`; the next active turn
          // resumes by advancing sessionStartedAt past the idle gap so the
          // idle time is NEVER billed. (overlay surface only — see
          // viewPause/dockOverlay.)
          paused: false, pausedAt: 0 };
        return;
      }
      // Resume a paused (idle-frozen) session: shift the absolute baseline
      // forward by the idle gap so the time the ad merely sat on screen is
      // not counted, then un-pause. lastTickMs/errorImpressionCount are
      // unchanged so emission cadence continues exactly where it left off.
      if (s.paused) {
        s.sessionStartedAt += Math.max(0, Date.now() - (s.pausedAt || Date.now()));
        s.paused = false;
        s.pausedAt = 0;
      }
      // No further anchor/baseline mutation — the absolute-epoch model uses
      // a single sticky sessionStartedAt (adjusted only across idle pauses).
    }
    // Suspend billing for an ad+surface without dropping its session, so the
    // overlay can persist on screen at idle while emitting NO view-time
    // events (user request: do not induce billing during idle periods).
    function viewPause(adId, surface) {
      if (!adId) return;
      var s = _vt[vtKey(adId, surface)];
      if (s && !s.paused) { s.paused = true; s.pausedAt = Date.now(); }
    }
    // END a view session outright (ported from the codex phantom-billing
    // fix — codex/block.asset.js viewEnd). Deleting the record stops the
    // 250ms accumulator the moment the ad leaves the screen; a later
    // viewShow() opens a FRESH session (new baseline, counters reset).
    function viewEnd(adId, surface) {
      try { delete _vt[vtKey(adId, surface)]; } catch (e) { /* best-effort */ }
    }
    function viewHide(adId, surface) {
      // Was a documented no-op, which left every hide call site —
      // dropOverlay, banner-hidden-during-turn, banner-gone — with an
      // immortal session emitting view_tick/error_impression every 5s
      // off-screen (the exact codex phantom-billing class). Hide now ENDS
      // the session. PERSIST-AT-IDLE is unaffected: dockOverlay uses
      // viewPause(), which keeps the session for the thaw to resume.
      viewEnd(adId, surface);
    }
    function viewMaybeEmit(s) {
      // Paused (idle-frozen) sessions emit nothing: no view_tick,
      // threshold_met, or error_impression while the ad merely persists.
      if (s.paused) return;
      var elapsed = Math.max(0, Date.now() - s.sessionStartedAt);
      // Tick at every TICK_MS boundary of elapsed time.
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
      // When view_tick fires, advance errorImpressionCount past the same
      // boundary so error_impression can't re-fire it on the next poll
      // (tickFired resets to false each call).
      if (tickFired && MAX_SESSION_MS > 0) {
        var syncCount = Math.floor(s.lastTickMs / MAX_SESSION_MS);
        if (syncCount > s.errorImpressionCount) {
          s.errorImpressionCount = syncCount;
        }
      }
      // Mutual exclusion: threshold_met fires once per session AND only
      // when no error_impression has fired yet this session. With the
      // default cap=5s / threshold=15s, error_impression always fires
      // first → threshold_met effectively never fires. Kept for the
      // disabled-cap config (MAX_SESSION_MS=0).
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
        dlog("view.threshold_met", { adId: s.adId, surface: s.surface,
          visibleMs: elapsed, eventUuid: thresholdEventUuid });
        ping("view_threshold_met" + q2);
      }
      // error_impression is the fallback for view_tick — only fire when
      // view_tick did NOT fire this poll. When both hit the same 5s
      // boundary they race the backend cooldown gate and double-bill.
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
        dlog("view.error_impression", { adId: s.adId, surface: s.surface,
          visibleMs: elapsed, fire: s.errorImpressionCount,
          eventUuid: errorEventUuid });
        ping("error_impression" + q3);
      }
    }
    // Snapshot of the elapsed session time for an ad+surface RIGHT NOW.
    // Read at click time so the loopback can apply the click-threshold
    // floor: clicks before the ad has been on-screen long enough are
    // logged but not billed (anti-misclick / anti-bot). Returns 0 when
    // the surface was never shown.
    function viewVisibleMsNow(adId, surface) {
      try {
        var s = _vt[vtKey(adId, surface)];
        if (!s) return 0;
        // While paused, elapsed is frozen at pausedAt (idle time excluded).
        var end = (s.paused && s.pausedAt) ? s.pausedAt : Date.now();
        return Math.max(0, end - s.sessionStartedAt);
      } catch (e) { return 0; }
    }

    // Suspend/wake clamp: elapsed is absolute wall-clock, so a laptop
    // suspend (or a long-frozen webview) would otherwise be billed as
    // visible time AND replayed as a synchronous view_tick burst on wake
    // (one tick per 5s of sleep — ~5760 POSTs after an 8h sleep). viewTick
    // tracks when it last polled; a gap of more than two tick intervals
    // means nothing was actually on screen, so every live (unpaused)
    // session's baseline is shifted forward past the gap, keeping at most
    // one TICK_MS of it billable — the catch-up loop then fires at most
    // ONE tick per wake. Paused sessions are skipped: their resume path
    // already excludes the whole pause window via pausedAt.
    var SUSPEND_GAP_MS = TICK_MS * 2;
    var _vtLastPollMs = 0;
    function viewTick() {
      try {
        var now = Date.now();
        var gap = _vtLastPollMs > 0 ? (now - _vtLastPollMs) : 0;
        _vtLastPollMs = now;
        if (gap > SUSPEND_GAP_MS) {
          var excess = gap - TICK_MS;
          for (var pk in _vt) {
            var ps = _vt[pk];
            if (!ps.paused) {
              // Math.min: never push a baseline into the future (a session
              // created post-wake, before this poll, must start at 0).
              ps.sessionStartedAt =
                Math.min(now, ps.sessionStartedAt + excess);
            }
          }
        }
        for (var k in _vt) viewMaybeEmit(_vt[k]);
      } catch (e) { /* prime directive */ }
    }
    setInterval(viewTick, 250);
    // visibilitychange flush removed in the absolute-epoch baseline: a
    // hidden webview keeps counting. Worst case bound = one bill per ad
    // per cooldown window (mutex + server-side gate). See top-of-section
    // comment for the full rationale.
    dlog("block.start", { base: BASE, tier: TIER, href: location.href });
    var _actLogged = false;
    function pollActivity() {
      try {
        fetch(BASE + "/activity").then(function (r) { return r.json(); })
          .then(function (j) {
            realAct = j;
            if (!_actLogged) { _actLogged = true;
              dlog("activity.first", { tool: j && j.tool, done: j && j.done }); }
          }).catch(function () {
            if (!_actLogged) { _actLogged = true; dlog("activity.fail"); }
          });
      } catch (e) { /* ignore */ }
    }
    // Telemetry-CONFIRMED: CC's "thinking" verb is a container whose class is
    // `spinnerRow_<hash>` (inside `messagesContainer_<hash> stickyMode_…`),
    // and CC animates its glyph in a CHILD of that row. We target THAT exact
    // element by its stable `spinnerRow_` class prefix — NOT a glyph/markdown
    // heuristic (which clobbered the Monaco editor: prime-directive
    // violation) and NOT by destroying its innerHTML (which killed CC's
    // animated child, froze our liveness signal, and made the ad vanish
    // after GRACE and never return). The hash suffix can change across CC
    // builds; matching the prefix substring is resilient, and if CC renames
    // it entirely the ad simply doesn't show (safe — prime directive over
    // visibility; the verb.dom telemetry will reveal the new class).
    // Prefer a spinnerRow with NON-EMPTY content (the live one). At turn end
    // CC empties the current spinnerRow to `<div></div>` (textContent "") but
    // keeps the `.spinnerRow_` node — returning that emptied node made the
    // idle test rely on rowActive() alone. An emptied/whitespace-only row is
    // treated as "no spinner" (=> idle path); only a node with real content
    // is a candidate. Still strictly class-scoped (cannot match editor /
    // markdown — prime directive preserved).
    // Audit #28: among those already-matched candidates prefer the LAST
    // non-empty row in document order. The transcript APPENDS, so the live
    // animating row is always the latest; CC can leave a STALE prior row
    // frozen mid-glyph (see GRACE_MS note above) while keeping it mounted —
    // returning the FIRST non-empty row let that dead row shadow the live
    // one mounted below it, so the freshness signature never changed and
    // the ad was suppressed for the whole turn. The selector and the
    // observation scope are UNCHANGED (prime directive: never widen
    // detection); only the choice AMONG matched rows differs. Known corner:
    // when the live row is emptied at turn end while a stale row remains,
    // the stale row briefly becomes "the" row again — its frozen signature
    // fails the freshness gate within GRACE_MS, so the normal idle dock
    // follows, same as before.
    function findSpinner() {
      var els = document.querySelectorAll('[class*="spinnerRow_"]');
      var last = null;
      for (var i = 0; i < els.length; i++) {
        if (els[i].nodeType !== 1) continue;
        if ((els[i].textContent || "").trim() !== "") last = els[i];
      }
      return last;
    }
    // Liveness gate: CC keeps spinnerRow MOUNTED after the turn (it only
    // vanished before because our mutation made React tear it out — we no
    // longer mutate). So "row present" is not idle-vs-active. CC animates a
    // sparkle glyph (✢✶✻✽) while thinking and stops it at turn end. Reading
    // the row's textContent is read-only / React-safe; this only ever
    // inspects the element already pinned by the spinnerRow_ class, so it
    // can never match editor/markdown text (no prime-directive risk).
    function rowActive(row) {
      if (!row) return false;
      var t = (row.textContent || "").replace(/^[\s ]+/, "");
      var c = t.charCodeAt(0);
      // ✢ U+2722, ✶ U+2736, ✻ U+273B, ✽ U+273D
      return c === 0x2722 || c === 0x2736 || c === 0x273b || c === 0x273d;
    }
    // The overlay MUST be opaque to cover CC's real verb glyph behind it
    // (transparent => the verb shows through and overlaps the ad into
    // garble). Sample CC's actual surface colour read-only (getComputedStyle
    // is reconciliation-safe): walk ancestors for the first non-transparent
    // background so the box blends into the chat panel (theme-matched) and
    // is never a hardcoded mismatched colour.
    function surfaceBg(el) {
      try {
        var n = el, hops = 0;
        while (n && n.nodeType === 1 && hops++ < 10) {
          var bg = (window.getComputedStyle(n) || {}).backgroundColor;
          if (bg && bg !== "transparent" &&
              bg !== "rgba(0, 0, 0, 0)") return bg;
          n = n.parentElement;
        }
      } catch (e) { /* no layout / jsdom — fall through */ }
      return "var(--vscode-editor-background,#1e1e1e)";
    }

    // Clicking the ad: the anchor's real http(s) href is what actually opens
    // the advertiser page — the VS Code webview host navigates it externally,
    // which is the ONLY click-out that survives CC's `default-src 'none'` CSP.
    // We therefore do NOT preventDefault (that would suppress the host's open).
    // The loopback /click ping is now purely the fire-and-forget billing
    // metric (CSP-revived by the companion extension.js connect-src patch);
    // losing it must never cost the click-through. Capture phase, fully guarded.
    document.addEventListener("click", function (ev) {
      var el = ev.target;
      while (el && el !== document) {
        if (el.getAttribute && el.getAttribute("data-vibe-ads-ad")) {
          // Walk up to find which surface contains this anchor so the click
          // ping carries surface= (mirrors impression events).
          var surface = "overlay";
          var p = el;
          while (p && p !== document) {
            try {
              if (p.getAttribute && p.getAttribute("data-vibe-ads-banner") === "1") {
                surface = "banner"; break;
              }
              if (p.getAttribute && p.getAttribute("data-vibe-ads-overlay") === "1") {
                surface = "overlay"; break;
              }
            } catch (e) { /* prime directive */ }
            p = p.parentNode;
          }
          // Include the current cumulative visible_ms so the extension-
          // side loopback can apply the click-threshold floor (don't bill
          // clicks before the ad has been visible long enough).
          var vms = viewVisibleMsNow(AD, surface);
          var clickEventUuid = newEventUuid();
          dlog("click.ad", { ct: CLICKTOKEN, surface: surface,
            visibleMs: vms, eventUuid: clickEventUuid });
          // `ad=` is the attribution CLAIM — the same param the view-event
          // pings carry (the pollAd-adopted identifier the block keys its
          // _vt sessions on, i.e. the AD text). Without it the host's
          // recent-ads registry (audit #17) could not resolve a click that
          // lands during the ≤10s /ad poll lag after a rotation and billed
          // it to the freshly-rotated campaign instead.
          ping("click?ct=" + encodeURIComponent(CLICKTOKEN)
            + "&corr=" + encodeURIComponent(CORR)
            + "&surface=" + encodeURIComponent(surface)
            + "&visible_ms=" + vms
            + "&ad=" + encodeURIComponent(AD)
            + "&event_uuid=" + encodeURIComponent(clickEventUuid));
          return;
        }
        el = el.parentNode;
      }
    }, true);

    // Ad-icon load failure → inline 'K' badge. The icon normally arrives as a
    // CSP-safe data: URI; this catches the residual cases (a stored https GCS
    // URL the backend couldn't inline, or a genuine 404) so the slot never
    // renders empty. `error` events don't bubble but DO fire in the capture
    // phase on ancestors, so one document-level capture listener covers the
    // overlay AND the banner. Programmatic by necessity — an inline onerror=""
    // is blocked by CC's webview script-src CSP. Idempotent: swapping outerHTML
    // for the SVG removes the data-va-icon node, so it can't re-fire.
    document.addEventListener("error", function (ev) {
      try {
        var t = ev && ev.target;
        if (t && t.tagName === "IMG" &&
            t.getAttribute && t.getAttribute("data-va-icon") === "1") {
          t.outerHTML = FAVICON_FALLBACK;
        }
      } catch (e) { /* prime directive: never let this disturb the page */ }
    }, true);

    // --- Usage-banner rewrite loop -------------------------------------
    // Runs every 1 s independent of the spinner's `active` gate (the banner
    // is visible at idle). findUsageBanner picks the tightest matching element
    // via looksLikeUsageBanner; when found, replaces its innerHTML with a
    // single clickable ad anchor (buildBannerHtml) mirroring the spinner
    // creative. Guarded against rewrite thrash via _bannerLast equality check;
    // found/miss each logged once.
    function findUsageBanner() {
      var els = document.querySelectorAll("span, div, p");
      var best = null, bestLen = Infinity;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children.length > 8) continue;          // not a leaf-ish node
        var t = (el.textContent || "").trim();
        if (t.length > 240) continue;                   // banner is short
        if (!looksLikeUsageBanner(t)) continue;
        if (t.length < bestLen) { best = el; bestLen = t.length; }
      }
      return best;
    }
    var _bannerLogged = false, _bannerLast = "", _bannerMissLogged = false;
    var _bannerEl = null;
    // Fires impression_rendered/viewable exactly once per session for the
    // banner surface. Spinner has its own (st.sentRender / st.wasVisible).
    var _bannerSentRender = false, _bannerSentViewable = false;
    // No-serve latch (wave-4 carry-over of the wave-2 /ad gate): the host
    // answers /ad with an EMPTY payload on a confirmed kill, a deliberate
    // disable, or any serving-gate refusal. A fetch ERROR is transient
    // network and keeps today's keep-last-ad behavior; a SUCCESSFUL empty
    // response is the no-serve signal. After TWO empty reads with no served
    // payload between them (debounce against a single racing read; fetch
    // errors neither count nor reset — only a real payload proves serving
    // resumed) the block stops SHOWING anything — overlay dropped, banner
    // hidden, every view session ended — instead of leaving the last
    // creative painted (unbillable but visible) until idle/reload. Any
    // served payload re-arms. The signed-out demo flow serves real
    // payloads, so this only engages on a genuine stop.
    var _adEmptyPolls = 0, _noServe = false;
    if (BANNER_ON) setInterval(function () {
      try {
        // No-serve: keep the banner hidden and its session ended until the
        // host serves again (see pollAd / enterNoServe).
        if (_noServe) {
          if (_bannerEl) {
            try { _bannerEl.style.setProperty("display", "none", "important"); }
            catch (e) { /* prime directive */ }
          }
          try { viewHide(AD, "banner"); } catch (e) { /* prime directive */ }
          return;
        }
        // IDLE-ONLY (user request): while CC is actively thinking the
        // spinner ad covers that turn — hide the banner ad. We keep a ref
        // to the element we clobbered (its text no longer matches
        // looksLikeUsageBanner, so findUsageBanner can't re-find it) and
        // just toggle display.
        if (_spinnerActive) {
          if (_bannerEl) {
            try { _bannerEl.style.setProperty("display", "none", "important"); }
            catch (e) { /* prime directive */ }
          }
          // W3: banner is hidden during spinner; END its visibility session
          // (it must not bill while display:none — a fresh session starts
          // when the banner un-hides at idle).
          try { viewHide(AD, "banner"); } catch (e) { /* prime directive */ }
          return;
        }
        var el = (_bannerEl && _bannerEl.isConnected)
          ? _bannerEl : findUsageBanner();
        if (!el) {
          if (!_bannerMissLogged) { _bannerMissLogged = true;
            dlog("banner.miss", {}); }
          // No banner element to render into → make sure the accumulator
          // isn't counting.
          try { viewHide(AD, "banner"); } catch (e) { /* prime directive */ }
          return;
        }
        try { el.style.removeProperty("display"); } catch (e) {}  // un-hide
        if (!_bannerLogged) { _bannerLogged = true;
          dlog("banner.found", { len: (el.textContent || "").length }); }
        var html = buildBannerHtml(AD, CLICKURL);
        if (el.getAttribute("data-vibe-ads-banner") === "1" &&
            _bannerLast === html) {
          // Still mounted + unchanged: ensure accumulator is running.
          try { viewShow(AD, "banner"); } catch (e) { /* prime directive */ }
          return;
        }
        el.innerHTML = html;
        el.setAttribute("data-vibe-ads-banner", "1");
        _bannerEl = el; _bannerLast = html;
        // W3: banner is now visible — start (or resume) accumulation.
        try { viewShow(AD, "banner"); } catch (e) { /* prime directive */ }
        // Initial impressions for the banner surface. Guarded so we only
        // fire once per block session (true first commit of the banner ad).
        if (!_bannerSentRender) {
          ping("impression_rendered?surface=banner&ad=" + encodeURIComponent(AD)
            + "&event_uuid=" + encodeURIComponent(newEventUuid()));
          _bannerSentRender = true;
        }
        if (!_bannerSentViewable) {
          var bVis = (typeof document.hidden === "undefined")
            ? true : !document.hidden;
          if (bVis) {
            ping("impression_viewable?surface=banner&ad="
              + encodeURIComponent(AD)
              + "&event_uuid=" + encodeURIComponent(newEventUuid()));
            _bannerSentViewable = true;
          }
        }
      } catch (e) {
        dlog("banner.error", { msg: String(e && e.message || e).slice(0, 160) });
      }
    }, 1000);

    // BODY-LEVEL OVERLAY — the ONLY React-safe architecture (proven 3×: any
    // mutation of CC's spinner subtree — innerHTML, child append, child
    // restyle — makes CC's next React reconciliation tear spinnerRow out and
    // never re-render it that turn). So we NEVER touch CC's tree: read its
    // rect READ-ONLY (getBoundingClientRect is reconciliation-safe) and paint
    // the ad in OUR OWN element appended to <body>, OUTSIDE React's roots,
    // absolutely positioned over the spinner. CC's spinner then behaves
    // natively (stays the whole turn, removed at turn end) so detection is
    // reliable every tick — the recurring "vanish / never return" is
    // structurally impossible. Liveness = spinnerRow PRESENT (not its rect:
    // jsdom has no layout, and presence is the true signal).
    var overlay = null;
    // True while CC is actively thinking (spinner ad shown). The usage-banner
    // ad is gated on the INVERSE of this: shown only at idle, hidden during a
    // turn (user request — it was visible all the time). It STAYS true while
    // the overlay is frozen at idle (below), so the persisted spinner ad
    // remains the sole ad surface and the banner stays suppressed.
    var _spinnerActive = false;
    // PERSIST-AT-IDLE → DOCK-TO-COMPOSER (user request): when CC goes idle we
    // don't drop the overlay AND we don't strand it at its last viewport pixel
    // (that floated over transcript content on scroll). Instead `_frozen`
    // marks idle (billing paused, "thinking" animation stopped) and we DOCK the
    // overlay as a compact line just above CC's input/composer box — a stable,
    // always-present bottom anchor — so it stays parked and out of the scrolled
    // transcript. The next active turn thaws (paint re-glues to the verb +
    // viewShow resumes the same session). If the composer can't be located on a
    // given CC build, we DROP the idle ad (prime-directive fallback) rather
    // than strand it. While idle the ad accrues NO view-time.
    var _frozen = false;       // idle: billing paused, animation stopped
    var _docked = false;       // idle overlay re-anchored above the composer
    var _dockNode = null;      // cached composer element (read-only rect target)
    function ensureOverlay(row) {
      if (overlay && overlay.parentNode) return overlay;
      overlay = document.createElement("div");
      overlay.setAttribute("data-vibe-ads", String(TIER));
      overlay.setAttribute("data-vibe-ads-overlay", "1");
      // OPAQUE, theme-matched bg: it must cover CC's verb glyph behind it
      // (transparent => verb shows through and overlaps the ad). The
      // earlier "box flashes over the input" concern is solved separately
      // by visibility:hidden until the FIRST placeOverlay sets real coords
      // — so opaque is safe AND the flash is gone.
      overlay.style.cssText =
        "position:fixed;z-index:2147483646;pointer-events:auto;" +
        "display:flex;align-items:center;box-sizing:border-box;" +
        "overflow:hidden;white-space:nowrap;visibility:hidden;background:" +
        surfaceBg(row);
      try { (document.body || document.documentElement).appendChild(overlay); }
      catch (e) { /* body not ready yet — retried next tick */ }
      return overlay;
    }
    var _rect = "";
    function placeOverlay(row) {
      try {
        var r = row.getBoundingClientRect();
        if (r && (r.width || r.height || r.top || r.left)) {
          // Only WRITE styles when the rect actually moved — a redundant
          // style write every 140ms forces needless recalc/compositing and
          // looked glitchy. (read is unavoidable; the write is what we gate.)
          var key = r.left + "," + r.top + "," + r.width + "," + r.height;
          if (key !== _rect) {
            _rect = key;
            overlay.style.left = r.left + "px";
            overlay.style.top = r.top + "px";
            overlay.style.minWidth = r.width + "px";
            overlay.style.height = r.height + "px";
            overlay.style.visibility = "visible";   // reveal once positioned
          }
        }
      } catch (e) { /* no layout (jsdom) — overlay still renders the ad */ }
    }
    // Locate CC's input/composer box — the stable, always-present element at
    // the panel bottom that the idle ad docks above. READ-ONLY (querySelector +
    // getBoundingClientRect only; the composer is NEVER mutated — prime
    // directive). This runs in the CC WEBVIEW document, which is isolated from
    // the VS Code workbench, so a generic editable-textbox selector cannot
    // match the Monaco editor. CC's composer is a contenteditable textbox
    // (newer builds use contenteditable="plaintext-only", not "true"); we try
    // the most specific selector first, then a plain textarea, and among
    // matches pick the LOWEST visible one (the composer sits at the bottom).
    // Returns null if nothing matches (CC restructured) — the caller then DROPS
    // the idle ad rather than stranding it. The matched selector/class is
    // logged once (composer.found) so the locator can be hardened to a stable
    // hashed class later, the way the spinnerRow_ locator was.
    var _composerLogged = false;
    function findComposer() {
      try {
        var sels = ['[contenteditable][role="textbox"]',
                    'div[contenteditable]', 'textarea'];
        for (var s = 0; s < sels.length; s++) {
          var els = document.querySelectorAll(sels[s]);
          var best = null, bestTop = -1;
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.nodeType !== 1) continue;
            var r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;   // visible only
            if (r.top > bestTop) { bestTop = r.top; best = el; }
          }
          if (best) {
            if (!_composerLogged) { _composerLogged = true;
              dlog("composer.found", { sel: sels[s], tag: best.tagName,
                cls: String(best.className || "").slice(0, 80) }); }
            return best;
          }
        }
      } catch (e) { /* no layout / prime directive */ }
      return null;
    }
    // Park the idle overlay as a compact line in the gap just above the
    // composer's top edge. Same read-only-rect technique as placeOverlay; keeps
    // the overlay's existing height (the last verb line-height) so it stays a
    // compact line and spans the composer width (theme-bg blends it in). The
    // "dock," key prefix keeps it distinct from placeOverlay's key so the first
    // dock write always lands.
    function placeDocked(composer) {
      try {
        var r = composer.getBoundingClientRect();
        if (r && (r.width || r.height || r.top || r.left)) {
          var h = overlay.offsetHeight || 20;
          var GAP = 4;
          var top = r.top - h - GAP;
          if (top < 0) top = 0;                  // clamp if composer near top
          var key = "dock," + r.left + "," + top + "," + r.width;
          if (key !== _rect) {
            _rect = key;
            overlay.style.left = r.left + "px";
            overlay.style.top = top + "px";
            overlay.style.minWidth = r.width + "px";
            overlay.style.visibility = "visible";
          }
        }
      } catch (e) { /* no layout */ }
    }
    function dropOverlay() {
      // W3: stop the overlay-surface visibility accumulator for the
      // current ad. Banner accumulator (if running) is independent.
      try { viewHide(AD, "overlay"); } catch (e) { /* prime directive */ }
      try { if (overlay && overlay.parentNode)
        overlay.parentNode.removeChild(overlay); } catch (e) {}
      overlay = null; _rect = ""; _shown = false;
      st.wasVisible = false; _spinnerActive = false; _frozen = false;
      _docked = false; _dockNode = null;
      st.simStart = 0;
      _chromeSig = ""; _dotsEl = null; _elapsedEl = null;
    }
    // Idle transition (replaces the old freeze-at-pixel). DOCK the overlay as a
    // compact line above CC's composer and pause billing. We deliberately keep
    // `overlay`, `lastNode`, `_spinnerActive`, `st.sentRender`, and
    // `st.wasVisible` set: the next active turn thaws (paint re-glues to the
    // verb + viewShow resumes the same impression session — no duplicate
    // impression_rendered/viewable). st.simStart is cleared so the per-turn
    // elapsed timer restarts at 0 next turn. The "thinking" dots are stopped
    // (cleared via the cached child's textContent — NEVER innerHTML, which would
    // detach the click anchor; see the clickable-overlay rule). PRIME-DIRECTIVE
    // FALLBACK: if the composer can't be located, DROP the ad rather than
    // strand it over content.
    function dockOverlay() {
      if (_frozen) return;
      var composer = findComposer();
      if (!composer) {
        dlog("loop.idle.dock_miss_drop", {});
        dropOverlay();
        lastNode = null;
        return;
      }
      _frozen = true;
      _docked = true;
      _dockNode = composer;
      try { viewPause(AD, "overlay"); } catch (e) { /* prime directive */ }
      st.simStart = 0;
      try { if (_dotsEl) _dotsEl.textContent = ""; } catch (e) { /* safe */ }
      placeDocked(composer);   // reposition immediately so it never strands
      dlog("loop.idle.dock", {});
    }
    // Host stopped serving (two consecutive empty /ad payloads — see the
    // _noServe declaration). Tear down every ad surface via the EXISTING
    // drop paths and end every view session: the wave-2 host gate already
    // refuses to BILL a stale overlay, this removes the PIXELS too.
    function enterNoServe() {
      if (_noServe) return;                 // idempotent
      _noServe = true;
      dlog("ad.no_serve", { emptyPolls: _adEmptyPolls });
      try { dropOverlay(); } catch (e) { /* best-effort */ }
      lastNode = null;
      try { if (_bannerEl) _bannerEl.style.setProperty(
        "display", "none", "important"); } catch (e) { /* prime directive */ }
      try { viewHide(AD, "banner"); } catch (e) { /* best-effort */ }
      // Belt & suspenders: END every remaining session. dropOverlay ended
      // the overlay's and viewHide the banner's; the wipe covers stragglers
      // so nothing can emit another view event while no-serve holds.
      try { _vt = Object.create(null); } catch (e) { /* best-effort */ }
    }
    // Audit #27: pollAd adopted a DIFFERENT ad while the overlay is parked
    // at idle (docked + frozen). paint() only runs in the active branch, so
    // without this the docked line kept showing the OLD creative — its
    // clicks opened the old URL but could not attribute (the old session is
    // gone → visible_ms 0 → host 15s click floor) or misattributed to the
    // new adId. Retarget the EXISTING stable child nodes ONLY: the ad-text
    // TEXT NODE inside the anchor (nodeValue write) and the anchor's href
    // attribute. NEVER innerHTML and never re-create the anchor — rewriting
    // a live clickable element detaches it mid-click (a shipped bug, fixed
    // once). The icon is retargeted in place too (a src swap on the EXISTING
    // img — the img is a SIBLING of the anchor, so the anchor is untouched):
    // the swap used to be deferred to the next thaw's rebuild, which left the
    // NEW ad's text docked beside the OLD ad's logo for the whole idle
    // period. When the icon node shape doesn't match the new creative (img
    // vs inline 'K' SVG) there is no anchor-safe in-place swap — fall through
    // to the drop path; a missing overlay beats a crossed icon/ad pair.
    // Billing: pollAd already wiped
    // _vt (the old ad's session is ENDED); the docked state stays
    // NON-billing per persist-at-idle, so NO live session is started here —
    // the next thaw's viewShow(AD) opens the NEW ad's session, and the
    // click ping reads the swapped AD module var, so both attribute to the
    // new ad. If the docked structure can't be retargeted safely
    // (unexpected children), fall back to the existing drop path so a stale
    // creative is never shown.
    function retargetDockedOverlay() {
      try {
        var a = overlay && overlay.querySelector('a[data-vibe-ads-ad]');
        var tn = a && a.firstChild;
        if (!a || !tn || tn.nodeType !== 3) {
          dlog("ad.dock_retarget_drop", {});
          dropOverlay();
          lastNode = null;
          return;
        }
        // Icon shape check BEFORE any mutation so a drop never leaves a
        // half-retargeted overlay. Tier <3 renders no icon at all — skip.
        var icon = (TIER >= 3)
          ? overlay.querySelector('img[data-va-icon="1"]') : null;
        if (TIER >= 3 && (ICON_URL ? !icon : !!icon)) {
          // New creative needs an img but the docked one has the 'K' SVG
          // (or vice versa): no anchor-safe in-place swap exists.
          dlog("ad.dock_retarget_drop", { why: "icon_shape" });
          dropOverlay();
          lastNode = null;
          return;
        }
        tn.nodeValue = AD;          // text node only — anchor never detached
        a.setAttribute("href", CLICKURL ? CLICKURL : "#");
        if (icon && ICON_URL) icon.setAttribute("src", ICON_URL);
        dlog("ad.dock_retarget", { toId: AD_ID });
      } catch (e) {
        // Never show a stale creative: drop on any error (prime directive —
        // dropOverlay only touches OUR element).
        try { dropOverlay(); lastNode = null; } catch (e2) { /* no-op */ }
      }
    }
    function paint(row, anim) {
      var now = Date.now();
      _verbSeq++;
      var gap = _lastVerbMs ? (now - _lastVerbMs) : 0;
      var reused = (row === _lastVerbEl);
      if (_verbSeq <= 12 || !reused || gap > 1200) {
        dlog("verb.dom", { seq: _verbSeq, reused: reused, gapMs: gap,
          tag: row.tagName, cls: String(row.className || "").slice(0, 80),
          kids: row.children.length,
          pCls: row.parentElement
            ? String(row.parentElement.className || "").slice(0, 80) : null,
          txt: (row.textContent || "").trim().slice(0, 40) });
      }
      _lastVerbEl = row; _lastVerbMs = now;
      lastNode = row; lastSeenMs = now;
      if (!_foundLogged) { _foundLogged = true;
        dlog("spinner.found", { cls: String(row.className || "").slice(0, 80) }); }
      if (anim) st.frame++;
      if (!st.simStart) st.simStart = now;        // elapsed = since turn start
      if (!st.sentRender) {
        ping("impression_rendered?surface=overlay&ad=" + encodeURIComponent(AD)
          + "&event_uuid=" + encodeURIComponent(newEventUuid()));
        st.sentRender = true;
      }
      var vis = (typeof document.hidden === "undefined")
        ? true : !document.hidden;
      if (vis && !st.wasVisible) {
        ping("impression_viewable?surface=overlay&ad=" + encodeURIComponent(AD)
          + "&event_uuid=" + encodeURIComponent(newEventUuid()));
      }
      st.wasVisible = vis;
      if (!_shown) { _shown = true; dlog("loop.adopt", { active: true }); }
      var o = ensureOverlay(row);
      _spinnerActive = true;
      // W3: this overlay-ad-session is now visible. The accumulator will
      // start counting visible time toward the threshold. AD is the ad
      // text rather than an ad_id — the block doesn't receive an id (the
      // backend correlates by client_id + ts + corr) so we pass the AD
      // string as the session key; same ad text in the same session
      // continues accumulating. Safe no-op when AD is empty.
      try { viewShow(AD, "overlay"); } catch (e) { /* prime directive */ }
      placeOverlay(row);
      var dots = ellipsis(st.frame);
      var elapsed = fmtElapsed(now - st.simStart);
      // AD_ID and ICON_URL are in the signature so a rotation between two
      // creatives with identical text+clickUrl, or a same-ad icon update,
      // still triggers the structural rebuild (the icon img is only written
      // on this path).
      var sig = TIER + "|" + AD_ID + "|" + AD + "|" + CLICKURL + "|" + ICON_URL;
      if (sig !== _chromeSig) {
        o.innerHTML = buildAdHtml(TIER, { ad: AD,
          href: CLICKURL, elapsed: elapsed, dots: dots });
        _chromeSig = sig;
        _dotsEl = o.querySelector('[data-va-dots]');
        _elapsedEl = o.querySelector('[data-va-elapsed]');
      } else {
        if (_dotsEl) _dotsEl.textContent = dots;
        if (_elapsedEl) {
          _elapsedEl.textContent = elapsed;
        }
      }
    }

    // POSITION on every animation frame so the overlay stays glued to the
    // spinner with zero perceptible lag — including while the user scrolls
    // or CC streams text and the row moves (the 140ms-only cadence left the
    // ad behind during scroll). This is ONE getBoundingClientRect on ONE
    // cached node per frame with the style WRITE gated to only-on-move — no
    // layout thrash (unlike the removed unthrottled capture scroll handler,
    // which fired many times per frame). rAF self-pauses when the tab is
    // hidden. Content/animation + detection/idle stay on the slower loop.
    function frame() {
      try {
        // Active: glue to the spinner verb. Idle+docked: keep parked above the
        // composer (cheap getBoundingClientRect on the cached _dockNode — never
        // a full-document query here; re-acquisition lives in evaluate()). If
        // _dockNode disconnected, hold position this frame; evaluate() re-finds.
        if (overlay && !_frozen && lastNode && lastNode.isConnected) {
          placeOverlay(lastNode);
        } else if (overlay && _frozen && _docked
                   && _dockNode && _dockNode.isConnected) {
          placeDocked(_dockNode);
        }
      } catch (e) { /* prime directive */ }
      try { window.requestAnimationFrame(frame); }
      catch (e) { setTimeout(frame, 16); }
    }
    try { window.requestAnimationFrame(frame); }
    catch (e) { setTimeout(frame, 16); }

    setInterval(pollActivity, 1000);

    // Live ad refresh: poll the loopback every 60s for the current ad from
    // the extension (which polls /v1/portfolio). When the ad changes, swap
    // the module-scope AD/CLICKURL/ICON_URL so the next paint() and banner
    // tick render the fresh creative without a VS Code reload.
    function pollAd() {
      try {
        fetch(BASE + "/ad").then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.adText) {
              // SUCCESSFUL response, no ad = the host's no-serve signal
              // (kill / disable / serving-gate refusal). Debounced to two
              // consecutive reads — see the _noServe declaration. A fetch
              // ERROR never reaches here (catch below keeps the last ad).
              _adEmptyPolls++;
              if (_adEmptyPolls >= 2) enterNoServe();
              return;
            }
            _adEmptyPolls = 0;
            if (_noServe) {
              // Host resumed serving (possibly the SAME creative). Re-arm:
              // the dropped overlay re-mounts on the next active paint()
              // and the banner repaints on its next 1s tick.
              _noServe = false;
              _bannerLast = "";
              dlog("ad.serve_resume", { adId: j.adId });
            }
            // Icon is part of the change check: a same-ad icon update (an
            // advertiser swaps their creative icon, or the backend's first
            // serve carried the raw https URL and a later one the inlined
            // data: URI) must be adopted too, or the stale icon sits next to
            // this ad for the life of the webview.
            var changed = (j.adId && j.adId !== AD_ID) || (j.adText !== AD)
              || (j.clickUrl !== CLICKURL) || ((j.iconUrl || "") !== ICON_URL);
            if (!changed) return;
            dlog("ad.rotated", { fromId: AD_ID, toId: j.adId, from: AD, to: j.adText });
            AD_ID = j.adId || AD_ID;
            AD = j.adText;
            CLICKURL = j.clickUrl || "";
            ICON_URL = j.iconUrl || "";
            // Rebuild favicon for new icon
            FAVICON = ICON_URL ? faviconImg(ICON_URL) : FAVICON_FALLBACK;
            // Reset view-time sessions: old ad's accumulated time must not
            // carry over to the new ad's billing.
            _vt = Object.create(null);
            st.sentRender = false;
            st.wasVisible = false;
            _bannerSentRender = false;
            _bannerSentViewable = false;
            // Force overlay re-render by clearing the chrome signature
            _chromeSig = "";
            _dotsEl = null;
            _elapsedEl = null;
            // Force banner re-render
            _bannerLast = "";
            // Audit #27: the docked idle overlay is not repainted by paint()
            // (it only runs in the active branch) — retarget its stable
            // child nodes in place so a stale creative never sits on screen.
            if (overlay && _frozen) retargetDockedOverlay();
          }).catch(function () {
            // Fetch ERROR (loopback unreachable / transient network): keep
            // the last ad — deliberately NOT the no-serve signal.
          });
      } catch (e) { /* ignore */ }
    }
    setInterval(pollAd, 10000);
    // Also poll once shortly after start to catch any rotation that
    // happened between patch-time and now.
    setTimeout(pollAd, 5000);

    // --- Defense-in-depth state evaluation -----------------------------
    // ONE shared evaluator, driven by FOUR independent signals so a miss in
    // any single one can't strand the overlay. Combine is biased toward
    // HIDING (a missed show is mild; a stuck overlay over CC's UI is the
    // failure that's burned us repeatedly).
    //   • DOM glyph  (findSpinner + rowActive)  — primary "show"
    //   • Transcript (realAct.done / staleness)  — DOM-independent force-HIDE
    //   • MutationObserver                       — instant edge, poll backup
    //   • visibilitychange + watchdog            — recover stale/wedged state
    var TXN_STALE_MS = 12000;     // no transcript activity this long => idle
    var _evaluating = false;
    function evaluate() {
      if (_evaluating) return;            // re-entrancy guard (observer+timer)
      _evaluating = true;
      try {
        // No-serve (host /ad gate — see pollAd/enterNoServe): never paint
        // or keep an overlay while the host has stopped serving, even with
        // a live spinner. Biased toward HIDE, matching this evaluator's
        // design. pollAd re-arms on the next served payload.
        if (_noServe) {
          if (overlay) { dropOverlay(); lastNode = null; }
          return;
        }
        var now = Date.now();
        var row = findSpinner();          // READ-ONLY, class-scoped
        // Content-freshness check (the missing piece that previously made
        // row 03 'after-prompt-idle' fail intermittently). CC leaves the
        // spinnerRow mounted at turn end with the LAST glyph still present
        // (e.g. ✻ frozen). rowActive() alone would keep reporting "active"
        // forever and paint() would keep animating the ad's dots. CC's
        // textContent may STILL be changing at idle (an elapsed-time/
        // timestamp child re-renders) so a whole-string signature is not
        // reliable. The truthful signal is the ANIMATED GLYPH: while
        // thinking CC cycles through {✢ U+2722, ✶ U+2736, ✻ U+273B,
        // ✽ U+273D}; at idle it freezes on one. We track the first non-
        // whitespace code point and only count the row as ACTIVE if that
        // code point CHANGED within GRACE_MS.
        if (row) {
          var t = (row.textContent || "").replace(/^[\s ]+/, "");
          var cc = t.charCodeAt(0) | 0;
          if (cc !== lastSig) { lastSig = cc; lastSigMs = now; }
        } else {
          lastSig = null;
        }
        var glyphLed = !!(row && rowActive(row));
        var fresh = glyphLed && lastSigMs > 0
          && (now - lastSigMs) <= GRACE_MS;
        var domActive = glyphLed && fresh;
        // Transcript second opinion (only when we actually have data — never
        // force-hide on missing/empty activity; DOM-only in that case).
        var txnIdle = !!(realAct && (realAct.done === true ||
          (typeof realAct.ts === "number" && realAct.ts > 0 &&
           (now - realAct.ts) > TXN_STALE_MS)));
        if (domActive && !txnIdle) {
          if (_frozen) {
            _frozen = false; _docked = false; _dockNode = null;
            dlog("loop.thaw", {});
          }
          paint(row, true);
        } else if (overlay && !_frozen && ((now - lastSeenMs) > GRACE_MS
            || txnIdle || (glyphLed && !fresh))) {
          // Turn ended (DOM idle past GRACE, OR the transcript says done, OR a
          // glyph-led row froze stale > GRACE_MS). DOCK the overlay above the
          // composer and pause billing — no longer freeze-at-pixel (which
          // floated over scrolled transcript content). The next active turn
          // thaws it. If the composer can't be found, dockOverlay() DROPS the
          // ad (prime-directive fallback).
          dlog("loop.idle.dock_enter",
            { sinceSeenMs: now - lastSeenMs, txnIdle: txnIdle,
              staleFrozen: glyphLed && !fresh });
          dockOverlay();
        } else if (overlay && _frozen && _docked
            && (!_dockNode || !_dockNode.isConnected)) {
          // Still idle but CC re-rendered/removed the composer element:
          // re-acquire it (the 80ms cadence absorbs the one querySelectorAll),
          // or DROP if it's truly gone — never strand the ad over content.
          var c2 = findComposer();
          if (c2) { _dockNode = c2; placeDocked(c2); }
          else {
            dlog("loop.idle.dock_lost_drop", {});
            dropOverlay(); lastNode = null;
          }
        }
      } catch (e) {
        dlog("loop.error", { msg: String(e && e.message || e).slice(0, 200) });
        /* prime directive: never disturb Claude Code */
      } finally { _evaluating = false; }
    }

    setInterval(evaluate, 80);  // primary cadence; rAF handles positioning

    // Signal 3 REMOVED — root cause of the CC crash. A whole-document
    // { childList:true, subtree:true } observer firing evaluate() (=
    // full-document querySelectorAll + getBoundingClientRect) on EVERY DOM
    // mutation meant that while CC streams a response (transcript mutates
    // per token) it ran hundreds of times/sec → main-thread saturation →
    // the webview goes unresponsive and VS Code terminates it. Intermittent
    // & load-dependent, so a quick test of 0.3.25 looked fine. The 80ms
    // interval detects within 80ms; the remaining bounded signals
    // (interval + rAF + transcript-idle + watchdog + visibilitychange)
    // preserve reliability with NO unbounded cost. Do not reintroduce a
    // document-wide subtree observer.

    // Signal 4a: rAF pauses while the tab is hidden, so a turn that ended in
    // the background could leave a stale overlay. Re-evaluate on re-show.
    try {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) evaluate();
      }, false);
      window.addEventListener("focus", function () { evaluate(); }, false);
    } catch (e) { /* no document/window — fine */ }

    // Signal 4b: independent watchdog. lastSeenMs refreshes every evaluate()
    // while genuinely active (even across multi-minute turns), so this only
    // fires if the main loop itself wedged (exception/throttle) yet the
    // overlay is still up — a true backstop against "stuck forever". Its own
    // timer so a broken evaluate() can't disable it.
    var WATCHDOG_MS = 15000;
    setInterval(function () {
      try {
        // `!_frozen`: a FROZEN overlay is stale-by-design (it persists at
        // idle), so the watchdog must ignore it — otherwise it would tear
        // down the persisted ad after 15s, defeating PERSIST-AT-IDLE. This
        // still catches a genuinely wedged ACTIVE overlay (loop threw/
        // throttled while a turn was live), which is the backstop's purpose.
        if (overlay && !_frozen && (Date.now() - lastSeenMs) > WATCHDOG_MS) {
          dlog("loop.watchdog", { sinceSeenMs: Date.now() - lastSeenMs });
          dropOverlay();
          lastNode = null;
        }
      } catch (e) { /* prime directive */ }
    }, 5000);
  } catch (e) { /* no-op */ }
})();
/* VIBE-ADS-END */
