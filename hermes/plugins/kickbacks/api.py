"""
Kickbacks.ai API client for Hermes Agent.

Handles: portfolio fetching (authenticated + demo), metrics reporting,
authentication, and earnings retrieval.

Backend: https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

import urllib.request
import urllib.error
from urllib.parse import urlparse


# ── Config ──────────────────────────────────────────────────────────────────

DEFAULT_BACKEND = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app"
DEFAULT_UPDATE_BASE = "https://kickbacks-public-gmdaqm2c7q-uw.a.run.app"

KICKBACKS_DIR = Path.home() / ".kickbacks"
AUTH_FILE = KICKBACKS_DIR / "auth.json"
CONFIG_FILE = KICKBACKS_DIR / "config.json"
AD_CACHE_FILE = KICKBACKS_DIR / "hermes-ad.json"
KEYCHAIN_SERVICE = "vibe-ads"
ENVELOPE_RE = re.compile(r"^(plain|keychain|dpapi|libsecret):1:(.*)$")


def _canonical_base(value: object) -> str:
    return str(value or "").strip().rstrip("/")


def _is_loopback_base(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except Exception:
        return False
    return parsed.hostname in ("localhost", "127.0.0.1", "::1")


def _is_official_base(value: str, official: str) -> bool:
    try:
        parsed = urlparse(value)
        expected = urlparse(official)
    except Exception:
        return False
    return parsed.scheme == expected.scheme and parsed.netloc == expected.netloc


def _allowed_service_base(value: object, official: str) -> Optional[str]:
    base = _canonical_base(value)
    if not base:
        return None
    if _is_official_base(base, official) or _is_loopback_base(base):
        return base
    return None


def _backend_base() -> str:
    """Resolve the backend base URL: official Kickbacks.ai or loopback only."""
    env = os.environ.get("KICKBACKS_BASE") or os.environ.get("VIBE_ADS_BASE")
    if env:
        return _allowed_service_base(env, DEFAULT_BACKEND) or DEFAULT_BACKEND
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
            if cfg.get("backendBaseUrl"):
                return _allowed_service_base(cfg["backendBaseUrl"], DEFAULT_BACKEND) or DEFAULT_BACKEND
        except (json.JSONDecodeError, KeyError):
            pass
    return DEFAULT_BACKEND


def _ensure_dir() -> None:
    KICKBACKS_DIR.mkdir(parents=True, exist_ok=True)


# ── Auth helpers ────────────────────────────────────────────────────────────

def _load_auth() -> dict:
    """Load cached auth tokens. Returns empty dict if none."""
    try:
        if AUTH_FILE.exists():
            return json.loads(AUTH_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _save_auth(data: dict) -> None:
    _ensure_dir()
    AUTH_FILE.write_text(json.dumps(data))
    try:
        AUTH_FILE.chmod(0o600)
    except OSError:
        pass


def get_access_token() -> Optional[str]:
    """Return the cached access token, or None."""
    return _load_auth().get("access_token")


def get_client_id() -> str:
    """Return the stable device client_id, creating one if needed."""
    auth = _load_auth()
    cid = auth.get("client_id") or auth.get("clientId")
    if not cid:
        cid = uuid.uuid4().hex[:24]
        auth["client_id"] = cid
        _save_auth(auth)
    return cid


def _open_secret_envelope(value: object) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    match = ENVELOPE_RE.match(value)
    if not match:
        return value
    scheme, payload = match.groups()
    if scheme == "plain":
        return payload
    if scheme == "keychain" and sys.platform == "darwin":
        try:
            result = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-s",
                    KEYCHAIN_SERVICE,
                    "-a",
                    payload,
                    "-w",
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=4,
            )
        except Exception:
            return None
        secret = result.stdout.rstrip("\r\n")
        return secret if result.returncode == 0 and secret else None
    if scheme == "libsecret":
        try:
            result = subprocess.run(
                ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", payload],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=4,
            )
        except Exception:
            return None
        secret = result.stdout.rstrip("\r\n")
        return secret if result.returncode == 0 and secret else None
    return None


def _seal_refresh_token(client_id: str, refresh_token: str) -> str:
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                [
                    "security",
                    "add-generic-password",
                    "-U",
                    "-s",
                    KEYCHAIN_SERVICE,
                    "-a",
                    client_id,
                    "-w",
                    refresh_token,
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=4,
            )
            if result.returncode == 0:
                return f"keychain:1:{client_id}"
        except Exception:
            pass
    return f"plain:1:{refresh_token}"


def _load_refresh_token(auth: Optional[dict] = None) -> Optional[str]:
    auth = auth or _load_auth()
    return _open_secret_envelope(auth.get("refresh_token") or auth.get("refresh"))


def refresh_access_token(explicit_refresh: Optional[str] = None) -> bool:
    """Refresh the access token from the stored Kickbacks refresh token.

    The official VS Code extension stores refresh tokens as at-rest envelopes
    such as ``keychain:1:<account>``. Hermes opens that envelope only in
    memory, sends it to Kickbacks' refresh endpoint, and re-seals any rotated
    refresh token back to the same local auth file.
    """
    auth = _load_auth()
    refresh_token = explicit_refresh or _load_refresh_token(auth)
    if not refresh_token:
        auth.pop("access_token", None)
        _save_auth(auth)
        return False

    status, body = _fetch(
        f"{_backend_base()}/v1/auth/refresh",
        method="POST",
        body={"refresh_token": refresh_token},
        timeout=15,
    )
    if status != 200:
        if status in (401, 403) or (400 <= status < 500 and "invalid_grant" in body.lower()):
            auth.pop("access_token", None)
            _save_auth(auth)
        return False

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False

    access_token = data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        return False

    client_id = auth.get("clientId") or auth.get("client_id") or get_client_id()
    auth["access_token"] = access_token
    rotated_refresh = data.get("refresh_token")
    if isinstance(rotated_refresh, str) and rotated_refresh:
        auth["refresh"] = _seal_refresh_token(str(client_id), rotated_refresh)
        auth.pop("refresh_token", None)
    if client_id:
        auth["clientId"] = str(client_id)
        auth["client_id"] = str(client_id)
    _save_auth(auth)
    return True


# ── HTTP helpers ────────────────────────────────────────────────────────────

def _fetch(url: str, method: str = "GET", body: Optional[dict] = None,
           headers: Optional[dict] = None, timeout: int = 15) -> tuple[int, str]:
    """Thin wrapper around urllib. Returns (status, body_text). Never throws."""
    hdrs = {"User-Agent": "Hermes-Kickbacks/0.1.0"}
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    try:
        # Use certifi for reliable SSL certificate verification
        import ssl
        try:
            import certifi
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            try:
                ssl_ctx = ssl.create_default_context()
            except Exception:
                ssl_ctx = None
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        return e.code, body_text
    except Exception as e:
        return 0, str(e)


# ── Portfolio ───────────────────────────────────────────────────────────────

class PatchAd:
    """A single ad creative from the portfolio."""
    __slots__ = ("ad_id", "campaign_id", "ad_text", "icon_ref", "icon_url",
                 "click_url", "banner_enabled", "session_token", "demo",
                 "_view_threshold_ms")

    def __init__(self, raw: dict, demo: bool = False):
        self.ad_id = raw.get("ad_id", "")
        self.campaign_id = raw.get("campaign_id", "")
        self.ad_text = raw.get("title_text", "")
        self.icon_ref = raw.get("icon_ref", "")
        self.icon_url = raw.get("icon_url", "")
        self.click_url = raw.get("click_url", "")
        self.banner_enabled = raw.get("banner_enabled", False)
        self.session_token = raw.get("session_token", "")
        self.demo = demo
        self._view_threshold_ms = 3000  # default, overridden by portfolio response

    def to_dict(self) -> dict:
        return {
            "ad_id": self.ad_id,
            "campaign_id": self.campaign_id,
            "ad_text": self.ad_text,
            "icon_ref": self.icon_ref,
            "icon_url": self.icon_url,
            "click_url": self.click_url,
            "banner_enabled": self.banner_enabled,
            "session_token": self.session_token,
            "demo": self.demo,
        }


class PortfolioResponse:
    """Full portfolio response from the backend."""
    __slots__ = ("ad", "ads", "queue_id", "ttl_ms", "rotation_interval_ms",
                 "view_threshold_ms", "balances")

    def __init__(self, raw: dict, demo: bool = False):
        ads_raw = raw.get("ads", [])
        self.ads = [PatchAd(a, demo=demo) for a in ads_raw]
        self.ad = self.ads[0] if self.ads else None
        self.queue_id = raw.get("queue_id", "")
        self.ttl_ms = (raw.get("ttl_seconds", 0) or 0) * 1000
        # Clamp rotation to safe minimum (15s) per kickbacks spec
        rotation_sec = raw.get("rotation_interval_seconds", 0) or 0
        raw_rotation_ms = rotation_sec * 1000 if rotation_sec else 120_000
        self.rotation_interval_ms = max(15_000, raw_rotation_ms)
        self.view_threshold_ms = (raw.get("view_threshold_seconds", 0) or 0) * 1000
        if self.view_threshold_ms <= 0:
            self.view_threshold_ms = 3_000  # default per spec

        balances_raw = raw.get("balances")
        if balances_raw and isinstance(balances_raw, dict):
            self.balances = {
                "lifetime_usd": balances_raw.get("lifetime_usd", "0.00"),
                "today_usd": balances_raw.get("today_usd", "0.00"),
                "last_updated_ms": balances_raw.get("last_updated_ms", 0),
            }
        else:
            self.balances = None


def fetch_portfolio(hermes_version: str = "hermes/0.1.0") -> Optional[PortfolioResponse]:
    """Fetch the authenticated ad portfolio. Returns None on failure."""
    base = _backend_base()
    token = get_access_token()
    if not token and _load_refresh_token():
        if refresh_access_token():
            token = get_access_token()

    if token:
        # Authenticated fetch
        url = f"{base}/v1/portfolio?claude_code_version={urllib.parse.quote(hermes_version)}"
        status, body = _fetch(url, headers={"Authorization": f"Bearer {token}"})
        if status == 200:
            try:
                return PortfolioResponse(json.loads(body))
            except (json.JSONDecodeError, KeyError):
                pass
        # Token might be expired; fall through to demo
        if status in (401, 403):
            if refresh_access_token():
                token = get_access_token()
                if token:
                    status, body = _fetch(url, headers={"Authorization": f"Bearer {token}"})
                    if status == 200:
                        try:
                            return PortfolioResponse(json.loads(body))
                        except (json.JSONDecodeError, KeyError):
                            pass

    # Demo (unauthenticated) fallback
    cid = get_client_id()
    url = (f"{base}/v1/portfolio/demo"
           f"?claude_code_version={urllib.parse.quote(hermes_version)}"
           f"&client_id={urllib.parse.quote(cid)}")
    status, body = _fetch(url)
    if status == 200:
        try:
            return PortfolioResponse(json.loads(body), demo=True)
        except (json.JSONDecodeError, KeyError):
            pass
    return None


# ── Metrics ─────────────────────────────────────────────────────────────────

def send_metric(event_type: str, ad: PatchAd, hermes_version: str = "hermes/0.1.0",
                corr: str = "", surface: str = "statusline",
                visible_ms: int = 0, session_token: str = "",
                session_nonce: str = "", event_uuid: str = "",
                viewable: bool = False, view_pct: float = 0.0,
                view_ms: int = 0) -> bool:
    """Send a metric event to the backend. Returns True on success (2xx)."""
    base = _backend_base()
    token = get_access_token()
    cid = get_client_id()
    if not event_uuid or not _is_valid_uuid(event_uuid):
        event_uuid = str(uuid.uuid4())
    body: dict = {
        "event_type": event_type,
        "ad_id": ad.ad_id,
        "campaign_id": ad.campaign_id,
        "client_id": cid,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "claude_code_version": hermes_version,
        "extension_version": "hermes-kickbacks/0.1.0",
        "nonce": event_uuid,
        "surface": surface,
    }
    if visible_ms:
        body["visible_ms"] = visible_ms
    if session_token:
        body["session_token"] = session_token
    if session_nonce:
        body["session_nonce"] = session_nonce
    if viewable:
        body["viewable"] = viewable
    if view_pct:
        body["view_pct"] = view_pct
    if view_ms:
        body["view_ms"] = view_ms
    path = "/v1/metrics" if token else "/v1/metrics/demo"
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if corr:
        headers["X-Kickbacks-Corr"] = corr
        headers["X-Vibe-Corr"] = corr
    status, resp_body = _fetch(f"{base}{path}", method="POST", body=body, headers=headers)
    print(f"[kickbacks] metric {event_type} token={bool(token)} status={status} ok={200 <= status < 300} ad={ad.ad_id if ad else ''} corr={corr[:12]}", flush=True)
    return 200 <= status < 300


# ── Earnings ────────────────────────────────────────────────────────────────

def fetch_earnings() -> Optional[dict]:
    """Fetch user earnings. Returns None if not authenticated."""
    token = get_access_token()
    if not token:
        return None
    base = _backend_base()
    status, body = _fetch(f"{base}/v1/earnings",
                          headers={"Authorization": f"Bearer {token}"})
    if status == 200:
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            pass
    return None


# ── Auth flow ───────────────────────────────────────────────────────────────

def start_sign_in() -> Optional[str]:
    """Initiate Google OAuth sign-in. Returns the authorization URL to open."""
    base = _backend_base()
    loc = None

    try:
        import ssl
        try:
            import certifi
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            ssl_ctx = ssl.create_default_context()

        # Use a custom opener that does NOT follow redirects
        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None  # Don't follow
        opener = urllib.request.build_opener(NoRedirectHandler())

        req = urllib.request.Request(
            f"{base}/v1/auth/extension/start",
            headers={"User-Agent": "Hermes-Kickbacks/0.1.0"})

        try:
            resp = opener.open(req, timeout=15)
            if resp.status in (307, 302, 301, 303):
                loc = resp.getheader("Location", "")
            resp.read()
        except urllib.error.HTTPError as e:
            # 3xx redirects raise HTTPError when not followed
            if e.code in (307, 302, 301, 303):
                loc = e.headers.get("Location", "")
    except Exception:
        return None

    if not loc:
        return None

    # Extract state from the Google OAuth URL
    from urllib.parse import parse_qs, urlparse
    parsed_loc = urlparse(loc)
    state = parse_qs(parsed_loc.query).get("state", [None])[0]
    if not state:
        return None

    _ensure_dir()
    signdata = _load_auth()
    signdata["pending_state"] = state
    signdata["pending_since"] = time.time()
    _save_auth(signdata)
    return loc


def poll_sign_in(timeout_seconds: int = 180) -> bool:
    """Poll for sign-in completion. Returns True if successful."""
    auth = _load_auth()
    state = auth.get("pending_state")
    if not state:
        return False

    base = _backend_base()
    deadline = time.time() + timeout_seconds
    poll_interval = 1.5

    while time.time() < deadline:
        status, body = _fetch(
            f"{base}/v1/auth/extension/poll?state={urllib.parse.quote(state)}")
        if status == 200:
            try:
                data = json.loads(body)
                if data.get("access_token"):
                    auth["access_token"] = data["access_token"]
                    if data.get("refresh_token"):
                        auth["refresh_token"] = data["refresh_token"]
                    auth.pop("pending_state", None)
                    auth.pop("pending_since", None)
                    _save_auth(auth)
                    return True
            except json.JSONDecodeError:
                pass
        time.sleep(poll_interval)
    # Timeout
    auth.pop("pending_state", None)
    auth.pop("pending_since", None)
    _save_auth(auth)
    return False


def is_signed_in() -> bool:
    return bool(get_access_token())


def sign_out() -> None:
    """Clear all auth state."""
    token = get_access_token()
    if token:
        base = _backend_base()
        try:
            _fetch(f"{base}/v1/auth/signout", method="POST",
                   body={"refresh_token": _load_auth().get("refresh_token", "")},
                   headers={"Authorization": f"Bearer {token}"})
        except Exception:
            pass
    # Clear auth file
    cid = get_client_id()
    _save_auth({"client_id": cid})


# ── Ad cache (for external display scripts) ─────────────────────────────────

def write_ad_cache(ad: PatchAd) -> None:
    """Write the current ad to a cache file for external display scripts."""
    _ensure_dir()
    data = {
        "ad_text": _strip_controls(ad.ad_text),
        "icon_ref": _strip_controls(ad.icon_ref),
        "icon_url": _strip_controls(ad.icon_url),
        "click_url": _strip_controls(ad.click_url),
        "ts": int(time.time() * 1000),
        "ad_id": ad.ad_id,
        "campaign_id": ad.campaign_id,
        "banner_enabled": ad.banner_enabled,
        "session_token": ad.session_token,
        "demo": ad.demo,
    }
    AD_CACHE_FILE.write_text(json.dumps(data))


def read_ad_cache() -> Optional[dict]:
    """Read the current ad cache. Returns None if no valid cache."""
    try:
        if not AD_CACHE_FILE.exists():
            return None
        data = json.loads(AD_CACHE_FILE.read_text())
        if not isinstance(data.get("ad_text"), str):
            return None
        return data
    except (json.JSONDecodeError, OSError):
        return None


def _strip_controls(s: str) -> str:
    """Strip control characters (C0 + DEL + C1) from a string."""
    return "".join(c for c in s if ord(c) >= 32 or c in "\n\r\t")


def _is_valid_uuid(s: str) -> bool:
    """Check if a string is a valid UUIDv4."""
    import re
    return bool(re.match(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        s, re.IGNORECASE
    ))


# Ensure the module is importable
import urllib.parse
