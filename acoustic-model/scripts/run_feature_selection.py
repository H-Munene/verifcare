#!/usr/bin/env python
"""CLI entrypoint for Phase 4 feature selection. See acoustic_model.feature_selection for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import feature_selection

if __name__ == "__main__":
    result = feature_selection.run()
    print(f"Feature selection complete: k={result['chosen_k']}. See results/feature_selection/feature_selection_summary.md")
