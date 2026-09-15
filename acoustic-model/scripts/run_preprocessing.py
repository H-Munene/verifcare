#!/usr/bin/env python
"""CLI entrypoint for Phase 2 preprocessing. See acoustic_model.preprocessing for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import preprocessing

if __name__ == "__main__":
    report_df = preprocessing.run()
    included = int(report_df["included"].sum())
    print(f"Preprocessing complete: {included}/{len(report_df)} files included. See results/preprocessing/preprocessing_summary.md")
