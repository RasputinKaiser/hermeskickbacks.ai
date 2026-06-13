import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from kickbacks import api


class ApiBoundaryTests(unittest.TestCase):
    def test_backend_base_defaults_to_official_endpoint(self):
        with patch.dict(api.os.environ, {}, clear=True), \
             patch.object(api, "CONFIG_FILE", Path("/tmp/kickbacks-missing-config.json")):
            self.assertEqual(api._backend_base(), api.DEFAULT_BACKEND)

    def test_backend_base_accepts_official_endpoint(self):
        official = f"{api.DEFAULT_BACKEND}/"

        with patch.dict(api.os.environ, {"KICKBACKS_BASE": official}, clear=True):
            self.assertEqual(api._backend_base(), api.DEFAULT_BACKEND)

    def test_backend_base_accepts_loopback_for_local_development(self):
        with patch.dict(api.os.environ, {"KICKBACKS_BASE": "http://127.0.0.1:6080/"}, clear=True):
            self.assertEqual(api._backend_base(), "http://127.0.0.1:6080")

    def test_backend_base_ignores_unrelated_external_env_host(self):
        with patch.dict(api.os.environ, {"KICKBACKS_BASE": "https://example.com"}, clear=True):
            self.assertEqual(api._backend_base(), api.DEFAULT_BACKEND)

    def test_backend_base_ignores_unrelated_external_config_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_file = Path(tmp) / "config.json"
            config_file.write_text(json.dumps({"backendBaseUrl": "https://example.com"}))

            with patch.dict(api.os.environ, {}, clear=True), \
                 patch.object(api, "CONFIG_FILE", config_file):
                self.assertEqual(api._backend_base(), api.DEFAULT_BACKEND)


if __name__ == "__main__":
    unittest.main()
