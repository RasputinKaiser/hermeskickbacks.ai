import time
import unittest
from unittest.mock import patch

import kickbacks as plugin_module
from kickbacks import api
from kickbacks.tracker import ImpressionTracker


def make_portfolio() -> api.PortfolioResponse:
    return api.PortfolioResponse(
        {
            "ads": [
                {
                    "ad_id": "ad-one",
                    "campaign_id": "camp-one",
                    "title_text": "First sponsor",
                    "click_url": "https://kickbacks.ai/one",
                    "session_token": "session-one",
                },
                {
                    "ad_id": "ad-two",
                    "campaign_id": "camp-two",
                    "title_text": "Second sponsor",
                    "click_url": "https://kickbacks.ai/two",
                    "session_token": "session-two",
                },
            ],
            "rotation_interval_seconds": 30,
            "view_threshold_seconds": 15,
        }
    )


class PluginCacheFallbackTests(unittest.TestCase):
    def tearDown(self):
        plugin_module._tracker = None
        plugin_module._portfolio_response = None
        plugin_module._rotation_index = -1

    def test_fetch_falls_back_to_fresh_cached_ad(self):
        plugin_module._tracker = ImpressionTracker()
        cached_ad = {
            "ad_id": "cached-ad",
            "campaign_id": "cached-campaign",
            "ad_text": "Cached sponsor",
            "click_url": "https://kickbacks.ai/cached",
            "demo": False,
            "ts": int(time.time() * 1000),
        }

        with patch.object(plugin_module.api, "fetch_portfolio", return_value=None), \
             patch.object(plugin_module.api, "read_ad_cache", return_value=cached_ad), \
             patch.object(plugin_module.api, "write_ad_cache"), \
             patch.object(plugin_module, "_schedule_fetch"):
            plugin_module._fetch_and_rotate_ads()

        self.assertIsNotNone(plugin_module._tracker.ad)
        self.assertEqual(plugin_module._tracker.ad.ad_id, "cached-ad")
        self.assertFalse(plugin_module._tracker.ad.demo)

    def test_empty_portfolio_cache_fallback_does_not_rewrite_cache(self):
        plugin_module._tracker = ImpressionTracker()
        cached_ad = {
            "ad_id": "cached-ad",
            "campaign_id": "cached-camp",
            "ad_text": "Cached sponsor",
            "click_url": "https://kickbacks.ai/cached",
            "demo": False,
            "ts": int(time.time() * 1000),
        }

        with patch.object(
            plugin_module.api,
            "fetch_portfolio",
            return_value=api.PortfolioResponse({"ads": []}),
        ), patch.object(plugin_module.api, "read_ad_cache", return_value=cached_ad), \
             patch.object(plugin_module.api, "write_ad_cache") as write_cache, \
             patch.object(plugin_module, "_schedule_fetch"):
            plugin_module._fetch_and_rotate_ads()

        self.assertIsNotNone(plugin_module._tracker.ad)
        self.assertEqual(plugin_module._tracker.ad.ad_id, "cached-ad")
        write_cache.assert_not_called()

    def test_first_fetch_uses_first_ad_then_rotates_with_paid_threshold(self):
        plugin_module._tracker = ImpressionTracker()
        portfolio = make_portfolio()

        with patch.object(plugin_module.api, "fetch_portfolio", return_value=portfolio), \
             patch.object(plugin_module.api, "write_ad_cache"), \
             patch.object(plugin_module, "_schedule_fetch"):
            plugin_module._fetch_and_rotate_ads()
            first_status = plugin_module._tracker.get_status()
            first_threshold = plugin_module._tracker.ad._view_threshold_ms

            plugin_module._fetch_and_rotate_ads()
            second_status = plugin_module._tracker.get_status()
            second_threshold = plugin_module._tracker.ad._view_threshold_ms

        self.assertEqual(first_status["ad_id"], "ad-one")
        self.assertEqual(first_threshold, 15_000)
        self.assertEqual(second_status["ad_id"], "ad-two")
        self.assertEqual(second_threshold, 15_000)


if __name__ == "__main__":
    unittest.main()
