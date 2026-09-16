import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import StratifiedGroupKFold

from acoustic_model import calibration, feature_selection


def _synthetic_train_pool(n_subjects=40, files_per_subject=3, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for subject_index in range(n_subjects):
        subject_id = f"subj_{subject_index:03d}"
        label = "dementia" if subject_index % 2 == 0 else "no_dementia"
        label_signal = 1.0 if label == "dementia" else 0.0
        for file_index in range(files_per_subject):
            rows.append(
                {
                    "file_id": f"{subject_id}_f{file_index:02d}",
                    "subject_id": subject_id,
                    "class_label": label,
                    "split": "train_pool",
                    "informative_1": label_signal * 3 + rng.normal(scale=0.4),
                    "informative_2": label_signal * 2 + rng.normal(scale=0.5),
                    "noise_1": rng.normal(),
                }
            )
    return pd.DataFrame(rows)


def test_outer_folds_identical_to_phase_4_5_6():
    df4 = feature_selection._load_train_pool_features()
    y4 = (df4["class_label"] == "dementia").astype(int)
    groups4 = df4["subject_id"]
    folds4 = feature_selection._build_folds(df4, y4, groups4)

    df7 = calibration._load_train_pool_features()
    y7 = (df7["class_label"] == "dementia").astype(int)
    groups7 = df7["subject_id"]
    folds7 = calibration._build_outer_folds(df7, y7, groups7)

    assert df4.equals(df7)
    assert len(folds4) == len(folds7)
    for (train4, val4), (train7, val7) in zip(folds4, folds7):
        assert np.array_equal(train4, train7)
        assert np.array_equal(val4, val7)


def test_outer_folds_never_split_a_subjects_files():
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    folds = calibration._build_outer_folds(df, y, groups)

    for train_idx, val_idx in folds:
        train_subjects = set(df.iloc[train_idx]["subject_id"])
        val_subjects = set(df.iloc[val_idx]["subject_id"])
        assert train_subjects.isdisjoint(val_subjects)


def test_calibration_cv_actually_respects_subject_grouping(monkeypatch):
    """The required regression test for the fix (ml-development-spec.md section
    9c): the manual calibration procedure must actually thread subject groups
    through its internal cross_val_predict call, not just run without error.
    Spies on StratifiedGroupKFold.split to capture what `groups` it was actually
    called with - this is exactly the failure mode the originally-sketched
    CalibratedClassifierCV(ensemble=False) fix silently hit (groups collapsing
    to a None/degenerate placeholder), verified directly against that failure
    before this test was written."""
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    features = ["informative_1", "informative_2", "noise_1"]

    captured_groups = []
    original_split = StratifiedGroupKFold.split

    def spy_split(self, X, y=None, groups=None):
        captured_groups.append(groups)
        yield from original_split(self, X, y, groups)

    monkeypatch.setattr(StratifiedGroupKFold, "split", spy_split)

    calibration.fit_calibrated_model("random_forest", {}, df[features], y, groups, inner_cv_folds=3)

    assert len(captured_groups) >= 1
    for captured in captured_groups:
        assert captured is not None
        assert list(captured) == list(groups)
        # A degenerate/broken routing would collapse groups to fewer unique
        # values than the real number of subjects (e.g. all-one-group) - the
        # exact failure the CalibratedClassifierCV(ensemble=False) route hit.
        assert len(set(captured)) == groups.nunique()


def test_fit_calibrated_model_produces_valid_probabilities_and_respects_locked_params():
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    features = ["informative_1", "informative_2", "noise_1"]

    calibrated = calibration.fit_calibrated_model(
        "svm",
        {"clf__C": 2.0, "clf__gamma": 0.5},
        df[features],
        y,
        groups,
        inner_cv_folds=3,
    )

    probs = calibrated.predict_proba_calibrated(df[features])
    assert probs.shape == (len(df),)
    assert (probs >= 0).all() and (probs <= 1).all()
    assert calibrated.pipeline.named_steps["clf"].C == 2.0
    assert calibrated.pipeline.named_steps["clf"].gamma == 0.5


def test_evaluate_folds_raw_vs_calibrated_auc_invariant_holds_on_real_run():
    """Sanity check that the invariant assertion inside evaluate_folds() doesn't
    spuriously fire on a realistic run - not just that it exists."""
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    features = ["informative_1", "informative_2", "noise_1"]
    outer_folds = calibration._build_outer_folds(df, y, groups)
    locked = {"random_forest": {}, "svm": {"clf__C": 1.0, "clf__gamma": "scale"}}

    fold_metrics, pooled = calibration.evaluate_folds(df, y, groups, features, locked, outer_folds)

    assert set(fold_metrics["model"]) == set(locked)
    assert len(fold_metrics) == len(outer_folds) * len(locked)
    for model_name in locked:
        assert set(pooled[model_name]["subject_id"]) == set(df["subject_id"])
        assert len(pooled[model_name]) == len(df)


def test_aggregate_metrics_sorts_by_brier_ascending():
    fold_metrics = pd.DataFrame(
        [
            {"fold": 0, "model": "a", "roc_auc": 0.7, "pr_auc": 0.6, "brier_score": 0.30},
            {"fold": 1, "model": "a", "roc_auc": 0.7, "pr_auc": 0.6, "brier_score": 0.28},
            {"fold": 0, "model": "b", "roc_auc": 0.65, "pr_auc": 0.55, "brier_score": 0.20},
            {"fold": 1, "model": "b", "roc_auc": 0.65, "pr_auc": 0.55, "brier_score": 0.22},
        ]
    )

    aggregated = calibration.aggregate_metrics(fold_metrics)

    assert aggregated.iloc[0]["model"] == "b"  # lower mean Brier comes first
    assert aggregated.iloc[1]["model"] == "a"


def test_pairwise_brier_comparison_bonferroni_corrects_by_three():
    fold_metrics = pd.DataFrame(
        [
            {"fold": f, "model": m, "brier_score": b}
            for f, (ba, bb, bc) in enumerate([(0.10, 0.30, 0.31), (0.11, 0.29, 0.30), (0.09, 0.31, 0.29)])
            for m, b in [("a", ba), ("b", bb), ("c", bc)]
        ]
    )

    pairwise = calibration.pairwise_brier_comparison(fold_metrics, ["a", "b", "c"])

    assert len(pairwise) == 3  # 3 pairwise comparisons among 3 models
    for _, row in pairwise.iterrows():
        assert row["n_family"] == 3
        assert row["p_bonferroni"] == pytest.approx(min(row["p_raw"] * 3, 1.0))
    # a is clearly, consistently better than both b and c - should be significant.
    a_vs_b = pairwise[(pairwise["model_a"] == "a") & (pairwise["model_b"] == "b")].iloc[0]
    assert a_vs_b["significant_at_0.05"]
    assert a_vs_b["mean_diff_a_minus_b"] < 0


def test_determine_winner_requires_beating_every_other_candidate():
    clear_winner = pd.DataFrame(
        [
            {"model_a": "a", "model_b": "b", "mean_diff_a_minus_b": -0.1, "significant_at_0.05": True},
            {"model_a": "a", "model_b": "c", "mean_diff_a_minus_b": -0.1, "significant_at_0.05": True},
            {"model_a": "b", "model_b": "c", "mean_diff_a_minus_b": 0.0, "significant_at_0.05": False},
        ]
    )
    assert calibration.determine_winner(clear_winner, ["a", "b", "c"]) == "a"

    no_winner = pd.DataFrame(
        [
            {"model_a": "a", "model_b": "b", "mean_diff_a_minus_b": -0.1, "significant_at_0.05": True},
            {"model_a": "a", "model_b": "c", "mean_diff_a_minus_b": 0.0, "significant_at_0.05": False},
            {"model_a": "b", "model_b": "c", "mean_diff_a_minus_b": 0.0, "significant_at_0.05": False},
        ]
    )
    assert calibration.determine_winner(no_winner, ["a", "b", "c"]) is None


def test_descriptive_threshold_analysis_returns_one_row_per_model():
    pooled = {
        "svm": pd.DataFrame(
            {
                "fold": [0, 0, 0, 0],
                "subject_id": ["s1", "s2", "s3", "s4"],
                "y_true": [0, 0, 1, 1],
                "y_prob": [0.1, 0.2, 0.7, 0.9],
            }
        )
    }

    result = calibration.descriptive_threshold_analysis(pooled)

    assert len(result) == 1
    assert result.iloc[0]["model"] == "svm"
    assert 0 <= result.iloc[0]["sensitivity_at_fixed_specificity"] <= 1 or np.isnan(
        result.iloc[0]["sensitivity_at_fixed_specificity"]
    )
