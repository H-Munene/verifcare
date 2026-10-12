"""Walking the raw dataset and measuring each file (PLAN.md Stage 1 steps 2, 5, 6)."""

import re

import pandas as pd
import soundfile as sf


def discover(dataset_dir):
    """One row per file with its class folder and person folder, taken from the path as found.

    Expected layout: <class folder>/<person folder>/<file>. Files anywhere else are kept, with
    layout_ok = False, so the summary reports them instead of silently skipping them.
    """
    rows = []
    for path in sorted(p for p in dataset_dir.rglob("*") if p.is_file()):
        parts = path.relative_to(dataset_dir).parts
        rows.append({
            "rel_path": path.relative_to(dataset_dir).as_posix(),
            "class_folder": parts[0],
            "person_folder": parts[1] if len(parts) == 3 else None,
            "filename": parts[-1],
            "layout_ok": len(parts) == 3,
        })
    return pd.DataFrame(rows)


def bit_depth(subtype):
    """'PCM_16' -> 16, 'FLOAT' -> 32, 'DOUBLE' -> 64, anything else -> None."""
    match = re.search(r"(\d+)$", subtype or "")
    if match:
        return int(match.group(1))
    return {"FLOAT": 32, "DOUBLE": 64}.get(subtype)


def file_facts(path):
    """Format and signal facts for one file. Never raises: an unreadable file is reported, not fatal."""
    facts = {"size_bytes": path.stat().st_size, "opens": False, "error": None}
    try:
        info = sf.info(path)
    except Exception as exc:  # any libsndfile failure means "does not open"
        facts["error"] = f"{type(exc).__name__}: {exc}"
        return facts
    facts.update({
        "opens": True,
        "container": info.format,
        "codec": info.subtype,
        "sample_rate": info.samplerate,
        "channels": info.channels,
        "bit_depth": bit_depth(info.subtype),
        "n_frames": info.frames,
        "duration_s": info.frames / info.samplerate if info.samplerate else 0.0,
    })
    return facts
