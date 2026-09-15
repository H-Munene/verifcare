#!/usr/bin/env python
"""CLI entrypoint for the Phase 2 subject-level split. See acoustic_model.splits for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import splits

if __name__ == "__main__":
    split_df = splits.run()
    counts = split_df["split"].value_counts().to_dict()
    print(f"Split complete: {counts}. See results/splits/splits_summary.md")
