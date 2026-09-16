#!/usr/bin/env python
"""CLI entrypoint for Phase 7 calibration. See acoustic_model.calibration for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import calibration

if __name__ == "__main__":
    result = calibration.run()
    print(f"Calibrated {len(result['model_names'])} models: {result['model_names']}")
    print(f"Winner (significantly lower Brier than all others): {result['winner']}")
    for row in result["aggregated"]:
        print(f"  {row['model']}: Brier={row['brier_score_mean']:.4f}")
    print("See results/calibration/calibration_summary.md")
