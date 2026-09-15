#!/usr/bin/env python
"""CLI entrypoint for Phase 3 feature extraction. See acoustic_model.features for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import features

if __name__ == "__main__":
    feature_df = features.run()
    print(f"Feature extraction complete: {len(feature_df)} files. See results/features/feature_extraction_summary.md")
