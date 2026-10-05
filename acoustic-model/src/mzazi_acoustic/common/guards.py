"""Test-set guard (PLAN.md 1.1): the only way any stage loads split-labelled data.

load_rows() returns training rows only. The test rows come back only with include_test=True, and
that flag may be passed in exactly one module, the Stage 5 final evaluation. A unit test scans the
code base to enforce it, so "the test set is used once" is a rule the code checks, not a promise.
"""

import pandas as pd

from mzazi_acoustic.common import config

SPLITS_FILE = config.PROCESSING_RESULTS / "splits.csv"
FINAL_EVALUATION_MODULE = "model_evaluation/final_evaluation.py"


def load_rows(table, splits=None, include_test=False):
    """Attach each row's split (by file_id) and drop test rows unless include_test is True.

    `table` is a DataFrame with a file_id column (e.g. the feature matrix). Rows that aren't in the
    splits file (not in the training pool) are dropped too, so nothing outside the pool leaks in.
    """
    if splits is None:
        splits = pd.read_csv(SPLITS_FILE)
    # The splits file is the only authority: a split column carried by the table itself (the feature
    # matrix has one) is dropped, so a table can't relabel a test row as training.
    table = table.drop(columns=["split", "role"], errors="ignore")
    # Training-pool rows only. Trajectory clips (dementia 10-15 y before onset) are in the splits file
    # with their person's side, but must never train a model (D7); they are scored separately.
    if "role" in splits:
        splits = splits[splits["role"] == "training_pool"]
    merged = table.merge(splits[["file_id", "split"]], on="file_id", how="inner", validate="one_to_one")
    if include_test:
        return merged
    training = merged[merged["split"] == "train"].reset_index(drop=True)
    assert (training["split"] == "train").all()
    return training
