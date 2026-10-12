"""Freezing and re-checking the raw dataset (PLAN.md Stage 0 step 3).

The freeze file lists every raw file's path, size and SHA-256. It is written once and then used at
the start of every later stage to prove data/raw/ hasn't changed. It lives under data/ (git-ignored)
because the paths contain real names.
"""

import hashlib

import pandas as pd

from mzazi_acoustic.common import config


def sha256_of(path, chunk_size=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def scan_raw_files(raw_dir=config.RAW_DIR):
    """One row per file under raw_dir: relative path, size in bytes, SHA-256."""
    rows = []
    for path in sorted(p for p in raw_dir.rglob("*") if p.is_file()):
        rows.append({
            "rel_path": path.relative_to(raw_dir).as_posix(),
            "size_bytes": path.stat().st_size,
            "sha256": sha256_of(path),
        })
    return pd.DataFrame(rows)


def freeze(raw_dir=config.RAW_DIR, freeze_file=config.RAW_FREEZE_FILE):
    if freeze_file.exists():
        raise FileExistsError(f"{freeze_file} already exists; the freeze is written once. "
                              "Delete it deliberately if the raw data was meant to change.")
    table = scan_raw_files(raw_dir)
    table.to_csv(freeze_file, index=False)
    return table


def verify(raw_dir=config.RAW_DIR, freeze_file=config.RAW_FREEZE_FILE):
    """Re-hash data/raw/ and compare with the freeze. Returns the current table; raises on any change."""
    frozen = pd.read_csv(freeze_file)
    current = scan_raw_files(raw_dir)
    merged = frozen.merge(current, on="rel_path", how="outer", suffixes=("_frozen", "_now"), indicator=True)
    missing = merged[merged["_merge"] == "left_only"]
    added = merged[merged["_merge"] == "right_only"]
    changed = merged[(merged["_merge"] == "both") & (merged["sha256_frozen"] != merged["sha256_now"])]
    if len(missing) or len(added) or len(changed):
        raise RuntimeError(f"Raw data differs from the freeze: {len(missing)} missing, "
                           f"{len(added)} added, {len(changed)} changed. See {freeze_file}.")
    return current
