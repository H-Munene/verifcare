"""Leakage guards for the split and folds (PLAN.md Stage 2 tests), on a synthetic pool."""

import numpy as np
import pandas as pd
import pytest

from mzazi_acoustic.data_processing import splits


def synthetic_pool(n_subjects=60, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for s in range(n_subjects):
        label = int(s < n_subjects // 3)
        for c in range(rng.integers(1, 4)):
            rows.append({"file_id": f"S{s:03d}_f{c}", "subject_id": f"S{s:03d}", "label": label})
    return pd.DataFrame(rows)


def test_no_subject_in_both_train_and_test():
    split = splits.make_split(synthetic_pool())
    assert split.groupby("subject_id")["split"].nunique().max() == 1
    share = split.drop_duplicates("subject_id")["split"].eq("test").mean()
    assert 0.1 < share < 0.3


def test_split_is_reproducible():
    pool = synthetic_pool()
    assert splits.make_split(pool).equals(splits.make_split(pool))


def test_no_subject_in_two_validation_folds_within_a_repeat_and_repeats_differ():
    split = splits.make_split(synthetic_pool())
    train = split[split["split"] == "train"]
    folds = splits.make_folds(train, n_folds=5, n_repeats=3)
    assert folds.groupby(["repeat", "subject_id"])["fold"].nunique().max() == 1
    assert (folds.groupby("repeat")["file_id"].nunique() == len(train)).all()
    first = folds[folds.repeat == 0].set_index("file_id")["fold"]
    second = folds[folds.repeat == 1].set_index("file_id")["fold"].reindex(first.index)
    assert not first.equals(second)


def test_split_script_refuses_to_run_before_d1(monkeypatch):
    import runpy
    from pathlib import Path

    from mzazi_acoustic.common import config

    monkeypatch.setattr(config, "D1_DECISION", None)
    script = Path(__file__).resolve().parents[2] / "scripts" / "02b_split.py"
    with pytest.raises(SystemExit, match="D1 is not decided"):
        runpy.run_path(str(script), run_name="__main__")


def test_leak_is_caught():
    bad = pd.DataFrame({"file_id": ["a", "b"], "subject_id": ["S1", "S1"], "split": ["train", "test"]})
    with pytest.raises(AssertionError):
        splits.check_split(bad)
