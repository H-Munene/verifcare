#!/usr/bin/env python
"""CLI entrypoint for Phase 8 interpretability. See acoustic_model.interpretability for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import interpretability

if __name__ == "__main__":
    result = interpretability.run()
    print(f"Computed confound_reliance_share for {len(result['model_names'])} models: {result['model_names']}")
    for row in result["aggregated"]:
        print(f"  {row['model']}: confound_reliance_share={row['confound_reliance_share_mean']:.4f}")
    print(f"Step 1 (confound_reliance_share) winner: {result['primary_winner']}")
    print(f"Step 2 (ECE tiebreak) winner: {result['secondary_winner']}")
    print(f"Final winner: {result['final_winner']}")
    print("See results/interpretability/interpretability_summary.md")
