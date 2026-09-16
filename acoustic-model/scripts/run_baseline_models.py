#!/usr/bin/env python
"""CLI entrypoint for Phase 5 baseline models. See acoustic_model.baseline_models for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import baseline_models

if __name__ == "__main__":
    result = baseline_models.run()
    print("Baseline models complete. Mean ROC-AUC by model:")
    for row in result["aggregated"]:
        print(f"  {row['model']}: {row['roc_auc_mean']:.4f}")
    print("See results/baseline_models/baseline_models_summary.md")
