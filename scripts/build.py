#!/usr/bin/env python3
"""
SNARP Profanity Index — build step.

Reads the raw analysis data from data/ and compiles a single artifact
(build/snarp-data.json) that index.html loads at runtime.

Sources
-------
  data/other-data/data_shape_snarp.md        one row per video: tiered counts, schools, rate
  data/other-data/data_granularity_snarp.txt per-video term breakdown (in INDEX order 0..N)
  data/transcripts/*.json                     timestamped transcripts ({video_id, segments:[...]})

Output
------
  build/snarp-data.json   ->  { "videos": [...], "transcripts": {video_id: {...}} }

Usage
-----
  python scripts/build.py
Run from the repo root. Re-run whenever you add a transcript or update the data files.
"""

import json
import re
import glob
import os

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA       = os.path.join(ROOT, "data")
OTHER      = os.path.join(DATA, "other-data")
TRANSCRIPTS= os.path.join(DATA, "transcripts")
BUILD      = os.path.join(ROOT, "build")

SHAPE_MD   = os.path.join(OTHER, "data_shape_snarp.md")
GRAN_TXT   = os.path.join(OTHER, "data_granularity_snarp.txt")

# markdown column index -> (field name, type)
COLS = [
    ("idx", int), ("id", str), ("title", str), ("minutes", float), ("words", int),
    ("mild", int), ("strong", int), ("severe", int), ("slurRace", int),
    ("slurSex", int), ("context", int), ("total", int), ("schools", str),
    ("perMin", float),
]
# granularity category headers, in the order they appear, mapped to the keys the page expects
GRAN_KEYS = [
    "mild_profanity", "strong_profanity", "severe_profanity",
    "identity_slur_race", "identity_slur_sexuality", "identity_context_needed",
]


def unescape_md(s):
    """Undo markdown backslash-escaping (e.g. 'video\\_id' -> 'video_id')."""
    return re.sub(r"\\(.)", r"\1", s).strip()


def parse_shape(path):
    """Parse the markdown summary table -> {index: video_dict}. Table may be in any row order."""
    videos = {}
    with open(path, encoding="utf-8") as f:
        rows = [ln for ln in f if ln.strip().startswith("|")]
    for line in rows[2:]:                       # skip header + separator
        cells = [c for c in line.split("|")[1:-1]]
        if len(cells) < len(COLS):
            continue
        rec = {}
        for (name, cast), raw in zip(COLS, cells):
            val = unescape_md(raw)
            if name == "schools":
                rec[name] = [] if re.search(r"unknown", val, re.I) else \
                    [s.strip() for s in val.split(",") if s.strip()]
            else:
                rec[name] = cast(val)
        rec["terms"] = {}
        videos[rec["idx"]] = rec
    return videos


def parse_granularity(path):
    """Parse the term-breakdown file -> list of {category: {term: count}}, in file (index) order."""
    blocks, cur, cat = [], None, None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            stripped = line.strip()
            if stripped == "COUNTS":
                if cur is not None:
                    blocks.append(cur)
                cur, cat = {}, None
                continue
            if cur is None or stripped in ("TERMS", "") or stripped.startswith("{"):
                continue
            head = re.match(r"^([a-z_]+):\s*$", line)
            if head and head.group(1) in GRAN_KEYS:
                cat = head.group(1)
                cur[cat] = {}
                continue
            term = re.match(r"^\s+(.+):\s*(\d+)\s*$", line)
            if term and cat:
                cur[cat][term.group(1)] = int(term.group(2))
    if cur is not None:
        blocks.append(cur)
    return blocks


def parse_transcripts(folder):
    """Read every transcript JSON -> {video_id: {duration, title, segments:[{s,e,t}]}}."""
    out = {}
    for fp in sorted(glob.glob(os.path.join(folder, "*.json"))):
        try:
            with open(fp, encoding="utf-8") as f:
                j = json.load(f)
        except Exception as e:
            print(f"  ! skipped {os.path.basename(fp)}: {e}")
            continue
        vid = j.get("video_id")
        if not vid:
            print(f"  ! {os.path.basename(fp)} has no video_id, skipping")
            continue
        out[vid] = {
            "duration": j.get("duration"),
            "title": j.get("title"),
            "segments": [
                {"s": round(float(s["start"]), 2),
                 "e": round(float(s["end"]), 2),
                 "t": s["text"].strip()}
                for s in j.get("segments", [])
            ],
        }
    return out


def main():
    videos_by_idx = parse_shape(SHAPE_MD)
    blocks = parse_granularity(GRAN_TXT)
    # granularity blocks are in index order: block i -> video with index i
    for i, terms in enumerate(blocks):
        if i in videos_by_idx:
            videos_by_idx[i]["terms"] = terms
    videos = [videos_by_idx[k] for k in sorted(videos_by_idx)]

    transcripts = parse_transcripts(TRANSCRIPTS)

    os.makedirs(BUILD, exist_ok=True)
    out_path = os.path.join(BUILD, "snarp-data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"videos": videos, "transcripts": transcripts},
                  f, ensure_ascii=False, separators=(",", ":"))

    have = sum(1 for v in videos if v["id"] in transcripts)
    print(f"Wrote {out_path}")
    print(f"  videos:      {len(videos)}")
    print(f"  transcripts: {len(transcripts)}  ({have}/{len(videos)} videos have one)")


if __name__ == "__main__":
    main()
