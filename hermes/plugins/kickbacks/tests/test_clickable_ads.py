import unittest
import importlib.machinery
import importlib.util
from pathlib import Path

import kickbacks as plugin_module
from kickbacks import api
from kickbacks.tracker import ImpressionTracker


def make_ad() -> api.PatchAd:
    return api.PatchAd(
        {
            "ad_id": "ad-click",
            "campaign_id": "campaign-click",
            "title_text": "Clickable sponsor",
            "click_url": "https://kickbacks.ai/click",
            "session_token": "session-click",
        }
    )


class ClickableAdTests(unittest.TestCase):
    def tearDown(self):
        plugin_module._tracker = None

    def test_tracker_status_exposes_click_url(self):
        tracker = ImpressionTracker()
        tracker.set_ad(make_ad(), write_cache=False)

        self.assertEqual(tracker.get_status()["click_url"], "https://kickbacks.ai/click")

    def test_kickbacks_command_renders_current_ad_as_markdown_link(self):
        plugin_module._tracker = ImpressionTracker()
        plugin_module._tracker.set_ad(make_ad(), write_cache=False)

        output = plugin_module._handle_kickbacks_command("")

        self.assertIn("\U0001f4e2 **Current ad:** [Clickable sponsor](https://kickbacks.ai/click)", output)

    def test_terminal_status_formats_ad_as_osc8_link(self):
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "hermes-kickbacks-status"
        loader = importlib.machinery.SourceFileLoader("hermes_kickbacks_status", str(script_path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        status_script = importlib.util.module_from_spec(spec)
        loader.exec_module(status_script)

        output = status_script.format_ad(
            {
                "ad_text": "Clickable sponsor",
                "click_url": "https://kickbacks.ai/click",
            }
        )

        self.assertEqual(
            output,
            "\033]8;;https://kickbacks.ai/click\033\\ad\u00b7 Clickable sponsor\033]8;;\033\\",
        )


if __name__ == "__main__":
    unittest.main()
