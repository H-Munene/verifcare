"""Subject-level train/test split and repeated subject-grouped CV folds (PLAN.md Stage 2 steps 6-7).

Everything is grouped by subject, so no person's clips are ever on both sides of a split or fold.
The folds are made once and saved; every later stage reads them from file, so all model
comparisons use identical folds.
"""

import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold

from mzazi_acoustic.common import config


def make_split(pool, seed=config.SEED, test_share=config.TEST_SUBJECT_SHARE):
    """Return pool with a 'split' column ('train'/'test'), about test_share of subjects in test.

    Uses one fold of a StratifiedGroupKFold with 1/test_share folds: grouped by subject and
    stratified by label, which a plain random subject split can't guarantee.
    `pool` needs file_id, subject_id, label.
    """
    n_splits = round(1 / test_share)
    splitter = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    _, test_index = next(splitter.split(pool, pool["label"], groups=pool["subject_id"]))
    result = pool[["file_id", "subject_id", "label"]].copy()
    result["split"] = "train"
    result.iloc[test_index, result.columns.get_loc("split")] = "test"
    check_split(result)
    return result


def make_folds(train, n_folds=config.CV_FOLDS, n_repeats=config.CV_REPEATS, seed=config.SEED):
    """One row per (training clip, repeat): the validation fold that clip falls in for that repeat.

    Repeat r uses seed + r, so the repeats differ from each other but are reproducible.
    """
    rows = []
    for repeat in range(n_repeats):
        splitter = StratifiedGroupKFold(n_splits=n_folds, shuffle=True, random_state=seed + repeat)
        for fold, (_, val_index) in enumerate(splitter.split(train, train["label"], groups=train["subject_id"])):
            part = train.iloc[val_index][["file_id", "subject_id", "label"]].copy()
            part["repeat"], part["fold"] = repeat, fold
            rows.append(part)
    folds = pd.concat(rows, ignore_index=True)
    check_folds(folds, n_repeats)
    return folds


def check_split(split):
    sides = split.groupby("subject_id")["split"].nunique()
    if (sides > 1).any():
        raise AssertionError(f"{int((sides > 1).sum())} subjects are in both train and test")


def check_folds(folds, n_repeats):
    per_repeat = folds.groupby(["repeat", "subject_id"])["fold"].nunique()
    if (per_repeat > 1).any():
        raise AssertionError("a subject appears in more than one validation fold within a repeat")
    counts = folds.groupby("repeat")["file_id"].nunique()
    if counts.nunique() != 1 or counts.size != n_repeats:
        raise AssertionError("every repeat must assign every training clip exactly once")


def describe(split, folds=None):
    """Class proportions per side (and per fold), for the Stage 2 summary."""
    per_side = split.groupby("split").agg(clips=("file_id", "size"), subjects=("subject_id", "nunique"),
                                          dementia_share_clips=("label", "mean"))
    people = split.drop_duplicates("subject_id").groupby("split")["label"].mean().rename("dementia_share_people")
    per_side = per_side.join(people).round(3)
    if folds is None:
        return per_side
    per_fold = folds.groupby(["repeat", "fold"]).agg(clips=("file_id", "size"), subjects=("subject_id", "nunique"),
                                                     dementia_share_clips=("label", "mean")).round(3)
    return per_side, per_fold
