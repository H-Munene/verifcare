#!/usr/bin/env python
"""CLI entrypoint for Phase 9 domain-shift robustness testing. See
acoustic_model.domain_shift_robustness for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import domain_shift_robustness

if __name__ == "__main__":
    result = domain_shift_robustness.run()
    print("Degradation curve (mean ROC-AUC / F1 across 5 folds):")
    for row in result["degradation_curve"]:
        print(f"  {row['condition']}: ROC-AUC={row['roc_auc_mean']:.4f}, F1={row['f1_mean']:.4f}")
    test = result["worst_case_test"]
    print(
        f"Pre-registered test ({test['worst_case_condition']} vs. clean, ROC-AUC): "
        f"p={test['p_value']:.4f}, significant={test['significant_at_0.05']}"
    )
    print("See results/domain_shift_robustness/domain_shift_robustness_summary.md")
