#!/usr/bin/env python3
"""Download ~N background images into data/background.

Sources (in order):
  1. Pexels API, if PEXELS_API_KEY is set in data/.env or the environment
     (real photos of tables/desks/fabrics).
  2. DTD texture dataset (no key needed) -- used as the fallback.

Usage:
    python download_backgrounds.py [N]
"""

import os
import random
import sys
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "background"
DTD_URL = "https://www.robots.ox.ac.uk/~vgg/data/dtd/download/dtd-r1.0.1.tar.gz"


def download(url, dest):
    print(f"downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as src:
        total = int(src.headers.get("Content-Length", 0) or 0)
        done = 0
        with open(dest, "wb") as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
                done += len(chunk)
                if total and done % (50 << 20) < (1 << 20):
                    print(f"  {done / 1e6:.0f} / {total / 1e6:.0f} MB")
    print(f"  saved {dest.stat().st_size / 1e6:.1f} MB")


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300

    pexels_key = os.environ.get("PEXELS_API_KEY")
    env_file = HERE / ".env"
    if env_file.exists() and not pexels_key:
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("PEXELS_API_KEY="):
                pexels_key = line.split("=", 1)[1].strip().strip('"').strip("'")

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.iterdir():
        if old.is_file():
            old.unlink()

    if pexels_key:
        count = download_pexels(pexels_key, n)
    else:
        count = download_dtd(n)
    print(f"{count} backgrounds -> {OUT}")


def download_pexels(key, n):
    """Fetch table/desk/fabric photos from the Pexels API."""
    queries = ["wooden table", "desk surface", "tablecloth", "fabric texture"]
    per_page = 80
    saved = 0
    for query in queries:
        page = 1
        while saved < n:
            url = (
                "https://api.pexels.com/v1/search"
                f"?query={urllib.parse.quote(query)}&per_page={per_page}&page={page}"
            )
            req = urllib.request.Request(url, headers={"Authorization": key})
            with urllib.request.urlopen(req) as r:
                import json

                data = json.load(r)
            photos = data.get("photos", [])
            if not photos:
                break
            for p in photos:
                if saved >= n:
                    return saved
                img_url = p["src"]["large2x"]
                dest = OUT / f"bg_{saved:04d}.jpg"
                try:
                    urllib.request.urlretrieve(img_url, dest)
                    saved += 1
                except Exception:
                    continue
            page += 1
        if saved >= n:
            break
    return saved


def download_dtd(n):
    tar_path = HERE / "_dtd.tar.gz"
    try:
        download(DTD_URL, tar_path)
        with tarfile.open(tar_path) as tf:
            members = [
                m
                for m in tf.getmembers()
                if m.isfile() and m.name.lower().endswith((".jpg", ".jpeg", ".png"))
            ]
        random.seed(0)
        random.shuffle(members)
        members = members[:n]
        with tarfile.open(tar_path) as tf:
            for i, m in enumerate(members):
                f = tf.extractfile(m)
                if f is not None:
                    (OUT / f"bg_{i:04d}{Path(m.name).suffix.lower()}").write_bytes(
                        f.read()
                    )
    finally:
        if tar_path.exists():
            tar_path.unlink()
    return len(members)


if __name__ == "__main__":
    main()
