import re, json, unittest.mock
from pathlib import Path

src = open("bulk-ingest.py").read().split('if __name__ == "__main__"')[0]
mock_out = json.dumps({"bucketName": "test", "region": "eu-west-1"})
with unittest.mock.patch("pathlib.Path.read_text", return_value=mock_out):
    exec(compile(src, "bulk-ingest.py", "exec"))

cases = [
    ("IMG-20191019-WA0041.jpg",               "2019-10-19",             2019, 10, 19),
    ("Screenshot_20201010-005850_WhatsApp.jpg","2020-10-10T00:58:50",   2020, 10, 10),
    ("20191019_173031.mp4",                    "2019-10-19T17:30:31",   2019, 10, 19),
    ("IMG_20130610_115612.jpg",                "2013-06-10T11:56:12",   2013,  6, 10),
    ("20180904_120522.jpg",                    "2018-09-04T12:05:22",   2018,  9,  4),
    ("Screenshot_20180618-164504.png",         "2018-06-18T16:45:04",   2018,  6, 18),
    ("IMG_7922.PNG",                           None,                    None, None, None),
    ("IMG_4768.JPG",                           None,                    None, None, None),
    ("319372_2289057875201_587104_n.jpg",      None,                    None, None, None),
    ("MVC-583F.JPG",                           None,                    None, None, None),
    ("IMG-20180420-WA0011.jpg",                "2018-04-20",            2018,  4, 20),
]

ok = fail = 0
for fname, exp_iso, exp_y, exp_mo, exp_d in cases:
    iso, y, mo, d = parse_filename_date(fname)
    passed = (y == exp_y and mo == exp_mo and d == exp_d)
    mark = "✓" if passed else "✗"
    if passed: ok += 1
    else:      fail += 1
    print("  %s  %-45s → %s" % (mark, fname, iso))

print("\n%d/%d passed" % (ok, ok+fail))
