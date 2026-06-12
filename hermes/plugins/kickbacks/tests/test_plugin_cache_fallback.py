import time
import unittest
from unittest.mock import patch

import kickbacks as plugin_module
from kickbacks.tracker import ImpressionTracker


class PluginCacheFallbackTests(unittest.TestCase):
    def tearDown(self):
        plugin_module._tracker = None
        plugin_module._portfolio_response = None

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


if __name__ == "__main__":
    unittest.main()
