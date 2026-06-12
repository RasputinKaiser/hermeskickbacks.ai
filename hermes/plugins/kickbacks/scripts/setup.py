#!/usr/bin/env python3
"""
Kickbacks.ai Hermes Plugin — Setup & Install Script

Run this once to configure the Kickbacks integration:
  python3 ~/.hermes/plugins/kickbacks/scripts/setup.py

This will:
  1. Create the ~/.kickbacks/ directory
  2. Set up the client ID
  3. Test connectivity to the kickbacks.ai backend
  4. Offer to enable the plugin in Hermes config
  5. Offer to sign in with Google
  6. Suggest terminal status bar integration
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


KICKBACKS_DIR = Path.home() / ".kickbacks"
AUTH_FILE = KICKBACKS_DIR / "auth.json"
CONFIG_FILE = Path.home() / ".hermes" / "config.yaml"


def banner():
    print()
    print("  🤑  Kickbacks.ai — Hermes Agent Plugin")
    print("  ═══════════════════════════════════════")
    print("  Get paid for waiting. Ads shown while Hermes thinks.")
    print()


def step(msg: str):
    print(f"  → {msg}")


def ok(msg: str = ""):
    print(f"  ✅ {msg}" if msg else "  ✅ Done.")


def fail(msg: str):
    print(f"  ❌ {msg}")


def main():
    banner()

    # 1. Create directories
    step("Creating ~/.kickbacks/ directory...")
    KICKBACKS_DIR.mkdir(parents=True, exist_ok=True)
    ok()

    # 2. Initialize client ID
    step("Setting up device identity...")
    if AUTH_FILE.exists():
        try:
            data = json.loads(AUTH_FILE.read_text())
            cid = data.get("client_id", "")
            if cid:
                ok(f"Existing client ID: {cid[:16]}...")
            else:
                cid = uuid.uuid4().hex[:24]
                data["client_id"] = cid
                AUTH_FILE.write_text(json.dumps(data))
                ok(f"New client ID: {cid[:16]}...")
        except (json.JSONDecodeError, OSError):
            cid = uuid.uuid4().hex[:24]
            AUTH_FILE.write_text(json.dumps({"client_id": cid}))
            ok(f"New client ID: {cid[:16]}...")
    else:
        cid = uuid.uuid4().hex[:24]
        AUTH_FILE.write_text(json.dumps({"client_id": cid}))
        ok(f"New client ID: {cid[:16]}...")

    # 3. Test API connectivity
    step("Testing kickbacks.ai API connectivity...")
    try:
        import urllib.request
        url = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app/v1/portfolio/demo"
        url += f"?claude_code_version=hermes%2F0.1.0&client_id={cid}"
        req = urllib.request.Request(url, headers={"User-Agent": "Hermes-Kickbacks/0.1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode())
                ads_count = len(data.get("ads", []))
                ok(f"Backend reachable. {ads_count} demo ad(s) available.")
            else:
                fail(f"Backend returned HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        fail(f"Backend returned HTTP {e.code}")
    except Exception as e:
        fail(f"Could not reach backend: {e}")

    # 4. Enable plugin
    step("Checking plugin enablement...")
    if CONFIG_FILE.exists():
        try:
            import yaml
            with open(CONFIG_FILE) as f:
                config = yaml.safe_load(f) or {}
            plugins = config.get("plugins", {})
            enabled = plugins.get("enabled", [])
            if "kickbacks" in enabled:
                ok("Plugin already enabled in config.yaml")
            else:
                print()
                print("  The 'kickbacks' plugin needs to be enabled.")
                ans = input("  Enable it now? [Y/n] ").strip().lower()
                if ans in ("", "y", "yes"):
                    if "enabled" not in plugins:
                        plugins["enabled"] = []
                    if "kickbacks" not in plugins["enabled"]:
                        plugins["enabled"].append("kickbacks")
                    config["plugins"] = plugins
                    with open(CONFIG_FILE, "w") as f:
                        yaml.safe_dump(config, f, default_flow_style=False)
                    ok("Enabled in config.yaml. Restart Hermes for changes to take effect.")
                else:
                    print("  Skipped. Run `hermes plugins enable kickbacks` to enable later.")
        except ImportError:
            print("  (yaml module not available — run `hermes plugins enable kickbacks` manually)")
        except Exception as e:
            print(f"  Could not update config: {e}")
    else:
        print("  No config.yaml found — run `hermes plugins enable kickbacks` after first launch.")

    # 5. Sign-in offer
    print()
    print("  ── Sign In (Optional) ──")
    print("  Signing in with Google enables revenue sharing (up to 50%).")
    print("  Without sign-in, you'll see demo ads but won't earn.")
    ans = input("  Start Google sign-in now? [y/N] ").strip().lower()
    if ans in ("y", "yes"):
        step("Opening sign-in flow...")
        # Import and run the plugin's sign-in
        sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
        try:
            from plugins.kickbacks import api
            url = api.start_sign_in()
            if url:
                import webbrowser
                webbrowser.open(url)
                print(f"  Browser opened: {url}")
                print("  Complete the Google sign-in, then return here...")
                print("  Polling for token (3 min timeout)...")
                success = api.poll_sign_in(timeout_seconds=180)
                if success:
                    ok("Signed in successfully!")
                else:
                    fail("Sign-in timed out. Try again with /kickbacks-signin in Hermes.")
            else:
                fail("Could not initiate sign-in flow.")
        except Exception as e:
            fail(f"Error: {e}")

    # 6. Terminal integration suggestions
    print()
    print("  ── Terminal Status Bar Integration ──")
    print("  Show kickbacks ads in your terminal status bar while Hermes thinks:")
    print()
    print("  tmux (add to ~/.tmux.conf):")
    print('    set -g status-right "#(python3 ~/.hermes/plugins/kickbacks/scripts/hermes-kickbacks-status)"')
    print()
    print("  fish prompt:")
    print("    function fish_prompt")
    print("      python3 ~/.hermes/plugins/kickbacks/scripts/hermes-kickbacks-status")
    print("      echo")
    print("      echo '$ '")
    print("    end")
    print()

    print("  🎉 Setup complete!")
    print("  Restart Hermes to activate the plugin.")
    print("  In Hermes, use /kickbacks to see your status and earnings.")


if __name__ == "__main__":
    main()
