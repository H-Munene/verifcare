"""Stage 3.1: extract the frozen feature set for every pool and trajectory clip (PLAN.md 3.1).

Runs only after the developer signs off the pause detector (config.DETECTOR_SIGNED_OFF) and the
split exists, so detector settings can never be adjusted after class results are seen.
Test rows are extracted too: extraction fits nothing, and Stage 5 needs their features. splits.csv
is read directly here, not through guards.load_rows, for that reason. Every modelling stage still
loads the matrix through the guard.
"""

import sys

import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering.features import extract_features


def main():
    splits_file = config.PROCESSING_RESULTS / "splits.csv"
    if not config.DETECTOR_SIGNED_OFF or not splits_file.exists():
        sys.exit("Not yet: feature extraction needs the detector signed off and splits.csv made.")
    config.FEATURE_RESULTS.mkdir(parents=True, exist_ok=True)

    splits = pd.read_csv(splits_file)
    report = pd.read_csv(config.PROCESSING_RESULTS / "processing_report.csv")
    clips = splits.merge(report[["file_id", "trimmed_s", "kept_s", "age_band", "bucket"]], on="file_id")

    rows = []
    for i, row in enumerate(clips.itertuples(), start=1):
        y, sr = sf.read(config.PROCESSED_DIR / f"{row.file_id}.wav", dtype="float32")
        rows.append({"file_id": row.file_id, **extract_features(y, sr)})
        if i % 25 == 0:
            print(f"  {i}/{len(clips)}")
    matrix = clips[["file_id", "subject_id", "label", "split", "role", "trimmed_s", "kept_s", "age_band", "bucket"]]
    matrix = matrix.merge(pd.DataFrame(rows), on="file_id")
    matrix.to_csv(config.FEATURE_RESULTS / "feature_matrix.csv", index=False)
    print(f"Wrote {len(matrix)} rows x {len(config.MODEL_FEATURES)} model features.")


if __name__ == "__main__":
    main()
