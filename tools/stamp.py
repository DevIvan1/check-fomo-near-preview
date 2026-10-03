#!/usr/bin/env python3
"""Stamps one content-hash version into every module import, index.html and the tests.

GitHub Pages serves files with `Cache-Control: max-age=600`. Without a version on every
module URL a browser can mix a fresh app.js with a stale cached module and fail to start.
Run before committing:  python tools/stamp.py
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
VER = re.compile(r"\?v=[0-9a-z]+")


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


sources = sorted([*ROOT.glob("js/*.js"), ROOT / "css" / "style.css", ROOT / "index.html", ROOT / "connect.html"])
digest = hashlib.sha1()
for path in sources:
    digest.update(VER.sub("", read(path)).encode("utf-8"))
version = digest.hexdigest()[:8]

module_ref = re.compile(r"""((?:\bfrom|\bimport|new URL\()\s*\(?\s*['"])(\.{1,2}/[^'"?]+\.js)(?:\?v=[0-9a-z]+)?(['"])""")
changed = []
for path in [*sorted(ROOT.glob("js/*.js")), ROOT / "tests" / "tests.js"]:
    text = read(path)
    new = module_ref.sub(lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", text)
    if new != text:
        write(path, new)
        changed.append(path.relative_to(ROOT))

page_ref = re.compile(r"""((?:href|src)=")((?:css|js)/[a-z0-9_-]+\.(?:css|js)|tests\.js)(?:\?v=[0-9a-z]+)?(")""")
for path in [ROOT / "index.html", ROOT / "connect.html", ROOT / "tests" / "index.html"]:
    text = read(path)
    new = page_ref.sub(lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", text)
    if new != text:
        write(path, new)
        changed.append(path.relative_to(ROOT))

print(f"version {version}; updated: {', '.join(map(str, changed)) or 'nothing'}")
