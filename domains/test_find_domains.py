"""python3 -m unittest domains/test_find_domains.py — no network needed."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_domains as fd  # noqa: E402

LIVE = {"https://www.105bets10.com/", "https://www.108bets10.com/"}


def fake_fetch(url):
    if url in LIVE:
        return url, 200, "<title>Bets10</title>"
    if url == "https://brand.example/":
        return "https://mirror-77.example/", 200, "<html>brand</html>"
    return None, "URLError", ""


class FindDomainsTest(unittest.TestCase):
    def setUp(self):
        self.real = fd.fetch
        fd.fetch = fake_fetch

    def tearDown(self):
        fd.fetch = self.real

    def test_numbered_picks_newest_live(self):
        rule = {"probe": "https://www.{n}bets10.com/", "n": 104, "back": 2, "ahead": 5, "expect": "<title>bets10",
                "urls": {"BASE": "https://www.{n}bets10.com/en"}}
        found, _ = fd.numbered(rule)
        self.assertEqual(found, {"n": 108})
        self.assertEqual(fd.urls_for(rule, found), {"BASE": "https://www.108bets10.com/en"})

    def test_numbered_none(self):
        rule = {"probe": "https://www.{n}bets10.com/", "n": 1, "back": 0, "ahead": 3, "expect": "bets10"}
        self.assertIsNone(fd.numbered(rule)[0])

    def test_redirect_follows_entry(self):
        rule = {"entries": ["https://dead.example/", "https://brand.example/"], "expect": "brand",
                "urls": {"BASE": "https://{host}"}}
        found, _ = fd.redirect(rule)
        self.assertEqual(fd.urls_for(rule, found), {"BASE": "https://mirror-77.example"})


if __name__ == "__main__":
    unittest.main()
