"""Final-evaluation helpers on synthetic data (the real test set is never touched by tests)."""

import numpy as np
import pandas as pd
import pytest

from mzazi_acoustic.model_evaluation import final_evaluation as fe


def test_threshold_metrics_by_hand():
    y = [1, 1, 0, 0, 0]
    p = [0.9, 0.2, 0.8, 0.1, 0.1]
    m = fe.threshold_metrics(y, p, np.ones(5), threshold=0.5)
    assert m["sensitivity"] == 0.5 and m["specificity"] == pytest.approx(2 / 3)
    assert m["precision"] == 0.5 and m["accuracy"] == pytest.approx(3 / 5)


def test_bootstrap_ci_brackets_the_point_estimate():
    rng = np.random.default_rng(0)
    n = 120
    y = np.repeat([1, 0], n // 2)
    p = np.clip(y * 0.3 + rng.normal(0.35, 0.15, n), 0, 1)
    subjects = [f"s{i // 2}" for i in range(n)]
    point = fe.all_metrics(y, p, subjects, 0.5)["roc_auc_person"]
    ci, used = fe.bootstrap_ci(y, p, subjects, 0.5, n_boot=200, rng=np.random.default_rng(1))
    assert used == 200 and ci["roc_auc_person"][0] < point < ci["roc_auc_person"][1]


def test_the_test_set_can_only_be_loaded_once(tmp_path, monkeypatch):
    marker = tmp_path / "used.json"
    splits = pd.DataFrame({"file_id": ["a", "b"], "split": ["train", "test"], "role": "training_pool"})
    monkeypatch.setattr(fe.guards, "load_rows", lambda table, include_test=False: table.merge(splits, on="file_id"))
    table = pd.DataFrame({"file_id": ["a", "b"], "x": [1, 2]})
    assert list(fe.load_test_rows(table, marker)["file_id"]) == ["b"]
    fe.mark_used({"n": 1}, marker)
    with pytest.raises(RuntimeError, match="already used"):
        fe.load_test_rows(table, marker)
