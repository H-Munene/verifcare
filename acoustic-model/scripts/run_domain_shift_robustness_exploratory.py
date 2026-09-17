#!/usr/bin/env python
"""CLI entrypoint for Phase 9's exploratory corrected-pink follow-up. Run
scripts/run_domain_shift_robustness.py first - this appends to its summary.
See acoustic_model.domain_shift_robustness.run_exploratory_corrected_pink for
the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import domain_shift_robustness

if __name__ == "__main__":
    summary = domain_shift_robustness.run_exploratory_corrected_pink()
    print(
        f"{summary['condition']}: realized SNR={summary['realized_snr_db_mean']:.2f}dB "
        f"(target 10dB), ROC-AUC={summary['roc_auc_mean']:.4f}, F1={summary['f1_mean']:.4f}"
    )
    print(f"clean ROC-AUC={summary['clean_roc_auc_mean']:.4f}")
    print("Appended to results/domain_shift_robustness/domain_shift_robustness_summary.md")
