"""Stage 2, part 2: subject-level train/test split and 5 x 5 CV folds (PLAN.md Stage 2 steps 6-7).

Refuses to run until decision D1 is recorded in config.D1_DECISION: excluding recordings
(D1 option c) can remove whole subjects, and speaker separation (option b) changes the audio,
so the split must not exist before D1.

Trajectory-only clips (dementia 10-15 y before onset) take their person's split, so a test
person's early clips are scored only by the final model. A person with only trajectory clips has
no pool clips and is marked 'trajectory_only_person': no model ever sees them.
"""

import sys

import pandas as pd

from mzazi_acoustic.common import config, raw_data
from mzazi_acoustic.data_processing import splits

OUT = config.PROCESSING_RESULTS


def main():
    if config.D1_DECISION is None:
        sys.exit("D1 is not decided (config.D1_DECISION is None): the split must not be made yet.")
    raw_data.verify()
    report = pd.read_csv(OUT / "processing_report.csv")
    pool = report[report["role"] == "training_pool"]
    split = splits.make_split(pool)
    train = split[split["split"] == "train"]
    folds = splits.make_folds(train)

    person_side = split.drop_duplicates("subject_id").set_index("subject_id")["split"]
    trajectory = report[report["role"] == "trajectory"][["file_id", "subject_id", "label"]].copy()
    trajectory["split"] = trajectory["subject_id"].map(person_side).fillna("trajectory_only_person")
    trajectory["role"] = "trajectory"
    split["role"] = "training_pool"

    pd.concat([split, trajectory], ignore_index=True).to_csv(OUT / "splits.csv", index=False)
    folds.to_csv(OUT / "cv_folds.csv", index=False)
    per_side, per_fold = splits.describe(split, folds)
    per_side.to_csv(OUT / "split_summary.csv")
    per_fold.to_csv(OUT / "fold_summary.csv")
    print(per_side.to_string())


if __name__ == "__main__":
    main()
