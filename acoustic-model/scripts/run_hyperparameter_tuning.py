#!/usr/bin/env python
"""CLI entrypoint for Phase 6 hyperparameter tuning. See acoustic_model.hyperparameter_tuning for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import hyperparameter_tuning

if __name__ == "__main__":
    result = hyperparameter_tuning.run()
    print(f"Stage 1 survivors (within one SE): {result['stage1_survivors']}")
    print(f"Stage 2 survivors (final, locked in): {result['stage2_survivors']}")
    print("See results/hyperparameter_tuning/hyperparameter_tuning_summary.md")
