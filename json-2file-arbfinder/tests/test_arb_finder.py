"""python3 -m unittest discover -s json-2file-arbfinder/tests"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import arb_finder  # noqa: E402
from books import identify, normalize  # noqa: E402

BWIN = {  # bwin-style: per-team "Total 1/2" lists are reversed
    "Corners": {
        "1X2": [{"name": "Spain", "odds": 1.5}, {"name": "X", "odds": 4}, {"name": "Uruguay", "odds": 5}],
        "Total": [{"name": "Total Over 9.5", "odds": 2.20}, {"name": "Total Under 9.5", "odds": 1.60}],
        "Total 1": [{"name": "Total 1 Over 4.5", "odds": 1.70}, {"name": "Total 1 Under 4.5", "odds": 2.30}],
    },
    "Fouls": {"Total": []},
}
BSON = {
    "Total Corners": [{"name": "Over 9.5", "odds": 1.60}, {"name": "Under 9.5", "odds": 2.10}],
    "Spain - Total Corners": [{"name": "Over 4.5", "odds": 1.90}, {"name": "Under 4.5", "odds": 1.90}],
    "Uruguay - Total Corners": [{"name": "Over 3.5", "odds": 1.90}, {"name": "Under 3.5", "odds": 1.90}],
    "Total Throw-ins": [{"name": "Over 40.5", "odds": 1.9}, {"name": "Under 40.5", "odds": 1.9}],
}
# canonical file from a brand-new book, teams listed away-first to test re-orientation
CANON = {
    "book": "newbook", "teams": ["Uruguay", "Spain"],
    "markets": {"corners_total": {"9.5": {"over": 1.70, "under": 2.25}},
                "corners_t2": {"4.5": {"over": 2.40, "under": 1.50}}},
}


def write(d, name, data):
    p = Path(d) / name
    p.write_text(json.dumps(data))
    return p


class ArbFinderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.paths = [
            write(d, "spain_-_uruguay_odds_bwin.json", BWIN),
            write(d, "spain_-_uruguay_odds_bson.json", BSON),
            write(d, "uruguay_vs_spain_odds_newbook.json", CANON),
        ]

    def tearDown(self):
        self.tmp.cleanup()

    def test_identify(self):
        books = [identify(p, json.loads(p.read_text())) for p in self.paths]
        self.assertEqual(books, [("bwin", "bwin"), ("bson", "bson"), ("newbook", "canonical")])

    def test_bwin_team_totals_are_reversed(self):
        n = normalize("bwin", BWIN, "Spain", "Uruguay")
        self.assertEqual(n["corners_t1"][4.5], {"Over": 2.30, "Under": 1.70})

    def test_canonical_teams_are_reoriented(self):
        n = normalize("canonical", CANON, "Spain", "Uruguay")
        self.assertIn("corners_t1", n)  # its t2 (Spain) is the group's t1

    def test_three_books_one_match(self):
        arbs, groups, counts, skipped = arb_finder.collect(self.paths)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["books"], ["bson", "bwin", "newbook"])
        self.assertEqual(counts["newbook"], 1)
        by = {(a["market_id"], a["line"]): a for a in arbs}
        tot = by[("corners_total", 9.5)]  # over 2.20 bwin, under 2.25 newbook
        self.assertEqual((tot["over_book"], tot["under_book"]), ("bwin", "newbook"))
        self.assertAlmostEqual(tot["profit_pct"], round((1 - (1 / 2.2 + 1 / 2.25)) * 100, 3))
        t1 = by[("corners_t1", 4.5)]  # over 2.40 newbook, under 1.90 bson -> 1/2.4+1/1.9 = 0.943
        self.assertEqual((t1["over_book"], t1["under_book"]), ("newbook", "bson"))
        self.assertEqual(t1["market"], "Spain - Total Corners")

    def test_json_cli(self):
        out = subprocess.run([sys.executable, str(HERE / "arb_finder.py"), "--json", *map(str, self.paths)],
                             capture_output=True, text=True, check=True).stdout
        self.assertGreaterEqual(len(json.loads(out)["arbs"]), 2)


if __name__ == "__main__":
    unittest.main()
