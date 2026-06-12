import time
import unittest
from unittest.mock import patch

from kickbacks import api
from kickbacks import tracker as tracker_module
from kickbacks.tracker import ImpressionTracker


def make_ad(ad_id: str = "ad-test") -> api.PatchAd:
    return api.PatchAd(
        {
            "ad_id": ad_id,
            "campaign_id": "campaign-test",
            "title_text": "Test sponsor",
            "click_url": "https://kickbacks.ai/test",
            "session_token": "session-test",
        }
    )


class ImpressionTrackerCaptureTests(unittest.TestCase):
    def setUp(self):
        self._originals = {
            "STOP_GRACE_MS": tracker_module.STOP_GRACE_MS,
            "AD_REST_MS": tracker_module.AD_REST_MS,
            "UNBILLED_REST_MS": tracker_module.UNBILLED_REST_MS,
            "MIN_IMPRESSION_MS": tracker_module.MIN_IMPRESSION_MS,
            "VIEW_THRESHOLD_MS": tracker_module.VIEW_THRESHOLD_MS,
            "TICK_MS": tracker_module.TICK_MS,
            "TICK_POLL_MS": tracker_module.TICK_POLL_MS,
        }
        tracker_module.STOP_GRACE_MS = 0
        tracker_module.AD_REST_MS = 100
        tracker_module.UNBILLED_REST_MS = 0
        tracker_module.MIN_IMPRESSION_MS = 50
        tracker_module.VIEW_THRESHOLD_MS = 5_000
        tracker_module.TICK_MS = 50
        tracker_module.TICK_POLL_MS = 10
        self.metric_events = []

        def record_metric(event_type, ad, *args, **kwargs):
            self.metric_events.append(
                {
                    "event": event_type,
                    "ad_id": ad.ad_id if ad else None,
                    "corr": kwargs.get("corr", ""),
                    "visible_ms": kwargs.get("visible_ms", 0),
                }
            )
            return True

        self.send_metric_patch = patch.object(
            tracker_module.api,
            "send_metric",
            side_effect=record_metric,
        )
        self.write_cache_patch = patch.object(tracker_module.api, "write_ad_cache")
        self.send_metric_patch.start()
        self.write_cache_patch.start()

    def tearDown(self):
        self.send_metric_patch.stop()
        self.write_cache_patch.stop()
        for name, value in self._originals.items():
            setattr(tracker_module, name, value)

    def test_unbillable_blip_does_not_impose_full_rest(self):
        impression = ImpressionTracker()
        impression.set_ad(make_ad())

        impression.start()
        time.sleep(0.01)
        impression.stop()

        impression.start()

        self.assertTrue(impression.is_showing)
        self.assertEqual(impression.get_status()["active_spans"], 1)

    def test_start_during_rest_resumes_when_work_remains_active(self):
        impression = ImpressionTracker()
        impression.set_ad(make_ad())

        impression.start()
        time.sleep(0.06)
        impression.stop()

        impression.start()
        self.assertFalse(impression.is_showing)
        self.assertTrue(impression.get_status()["start_pending"])

        time.sleep(0.15)

        self.assertTrue(impression.is_showing)
        self.assertEqual(impression.get_status()["active_spans"], 1)

    def test_ad_refresh_does_not_retarget_active_capture_metrics(self):
        impression = ImpressionTracker()
        impression.set_ad(make_ad("ad-original"))

        impression.start()
        impression.set_ad(make_ad("ad-refresh"))
        time.sleep(0.06)
        impression.stop()

        billed_events = [
            event
            for event in self.metric_events
            if event["event"] in {"view_tick", "error_impression", "view_threshold_met"}
        ]
        self.assertTrue(billed_events)
        self.assertEqual({event["ad_id"] for event in billed_events}, {"ad-original"})
        self.assertTrue(all(event["corr"].startswith("ad-original.") for event in billed_events))

    def test_set_ad_starts_capture_when_work_already_active(self):
        impression = ImpressionTracker()

        impression.start()
        self.assertFalse(impression.is_showing)

        impression.set_ad(make_ad())

        self.assertTrue(impression.is_showing)
        self.assertEqual(impression.get_status()["active_spans"], 1)

    def test_long_capture_emits_periodic_ticks_before_stop(self):
        impression = ImpressionTracker()
        ad = make_ad()
        ad._view_threshold_ms = 120
        impression.set_ad(ad)

        impression.start()
        time.sleep(0.075)

        tick_events = [event for event in self.metric_events if event["event"] == "view_tick"]
        self.assertTrue(tick_events)
        self.assertEqual(tick_events[0]["visible_ms"], 50)

        impression.stop()

    def test_uses_portfolio_threshold_for_threshold_met(self):
        impression = ImpressionTracker()
        ad = make_ad()
        ad._view_threshold_ms = 75
        impression.set_ad(ad)

        impression.start()
        time.sleep(0.11)
        impression.stop()

        threshold_events = [
            event for event in self.metric_events if event["event"] == "view_threshold_met"
        ]
        self.assertTrue(threshold_events)
        self.assertGreaterEqual(threshold_events[0]["visible_ms"], 75)


if __name__ == "__main__":
    unittest.main()
