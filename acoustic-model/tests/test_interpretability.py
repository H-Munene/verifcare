import numpy as np
import pandas as pd
import pytest
from sklearn.base import is_classifier

from acoustic_model import calibration, interpretability


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


def test_outer_folds_reused_directly_from_calibration():
    """Phase 8 must reuse Phase 4/5/6/7's exact same outer-fold builder, not a
    separately-defined one that happens to produce the same result - checked
    by identity, not just equal output."""
    assert interpretability._build_outer_folds is calibration._build_outer_folds


def test_adapter_is_recognized_as_a_classifier_by_sklearn():
    """Regression test for a real, non-obvious bug found while building this
    adapter: with BaseEstimator listed before ClassifierMixin, sklearn's MRO
    resolves __sklearn_tags__ to BaseEstimator's own untagged version, so
    is_classifier() silently returns False and permutation_importance's
    roc_auc scorer never reduces predict_proba's (n, 2) output to a single
    score column - not merely "the code runs without error"."""

    class _DummyBase:
        def predict_proba(self, x):
            p1 = np.full(len(x), 0.5)
            return np.column_stack([1 - p1, p1])

        def raw_scores(self, x):
            return np.full(len(x), 0.0)

        def predict_proba_calibrated(self, x):
            return self.predict_proba(x)[:, 1]

    adapter = interpretability._CalibratedProbaAdapter(_DummyBase())
    assert is_classifier(adapter)
    assert list(adapter.classes_) == [0, 1]


def test_adapter_predict_proba_shape_and_range():
    class _DummyCalibrated:
        def predict_proba_calibrated(self, x):
            return np.linspace(0.1, 0.9, len(x))

    adapter = interpretability._CalibratedProbaAdapter(_DummyCalibrated())
    x = pd.DataFrame({"a": range(10)})
    probs = adapter.predict_proba(x)

    assert probs.shape == (10, 2)
    assert np.allclose(probs.sum(axis=1), 1.0)
    assert (probs >= 0).all() and (probs <= 1).all()


def test_permutation_importance_runs_with_adapter_and_roc_auc_scorer():
    """End-to-end check that the adapter actually lets sklearn's built-in
    "roc_auc" scorer work through permutation_importance - the whole reason
    the adapter exists (section 9d)."""
    from sklearn.inspection import permutation_importance
    from sklearn.linear_model import LogisticRegression

    rng = np.random.default_rng(0)
    x = pd.DataFrame(rng.normal(size=(200, 3)), columns=["a", "b", "c"])
    y = (x["a"] + rng.normal(scale=0.5, size=200) > 0).astype(int)
    base = LogisticRegression().fit(x, y)

    class _DummyCalibrated:
        def predict_proba_calibrated(self, x):
            return base.predict_proba(x)[:, 1]

    adapter = interpretability._CalibratedProbaAdapter(_DummyCalibrated())
    result = permutation_importance(adapter, x, y, scoring="roc_auc", n_repeats=5, random_state=0)

    assert result.importances_mean.shape == (3,)
    # "a" is the only informative feature - its importance drop should dwarf the others.
    assert result.importances_mean[0] > result.importances_mean[1]
    assert result.importances_mean[0] > result.importances_mean[2]


def test_compute_fold_importances_returns_one_row_per_fold_model_feature():
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    features = ["informative_1", "informative_2", "noise_1"]
    outer_folds = calibration._build_outer_folds(df, y, groups)
    locked = {"random_forest": {}, "svm": {"clf__C": 1.0, "clf__gamma": "scale"}}

    fold_importances = interpretability.compute_fold_importances(df, y, groups, features, locked, outer_folds)

    assert set(fold_importances["model"]) == set(locked)
    assert set(fold_importances["feature"]) == set(features)
    assert len(fold_importances) == len(outer_folds) * len(locked) * len(features)


def test_compute_confound_reliance_share_clips_negative_drops_before_summing(monkeypatch):
    monkeypatch.setattr(interpretability, "CONFOUND_FEATURE", "jitter_like")
    fold_importances = pd.DataFrame(
        [
            {"fold": 0, "model": "svm", "feature": "jitter_like", "importance_drop": 0.10},
            {"fold": 0, "model": "svm", "feature": "other_1", "importance_drop": 0.30},
            {"fold": 0, "model": "svm", "feature": "other_2", "importance_drop": -0.05},  # clipped to 0
        ]
    )

    shares = interpretability.compute_confound_reliance_share(fold_importances)

    assert len(shares) == 1
    row = shares.iloc[0]
    assert row["confound_importance_drop"] == pytest.approx(0.10)
    assert row["total_clipped_importance_drop"] == pytest.approx(0.40)  # 0.10 + 0.30 + 0 (clipped)
    assert row["confound_reliance_share"] == pytest.approx(0.25)


def test_compute_confound_reliance_share_is_nan_when_everything_clips_to_zero(monkeypatch):
    monkeypatch.setattr(interpretability, "CONFOUND_FEATURE", "jitter_like")
    fold_importances = pd.DataFrame(
        [
            {"fold": 0, "model": "svm", "feature": "jitter_like", "importance_drop": -0.01},
            {"fold": 0, "model": "svm", "feature": "other_1", "importance_drop": -0.02},
        ]
    )

    shares = interpretability.compute_confound_reliance_share(fold_importances)

    assert np.isnan(shares.iloc[0]["confound_reliance_share"])
    assert shares.iloc[0]["total_clipped_importance_drop"] == pytest.approx(0.0)


def test_aggregate_confound_reliance_sorts_ascending_and_reports_valid_fold_count():
    fold_shares = pd.DataFrame(
        [
            {"fold": 0, "model": "a", "confound_reliance_share": 0.5},
            {"fold": 1, "model": "a", "confound_reliance_share": 0.7},
            {"fold": 0, "model": "b", "confound_reliance_share": 0.1},
            {"fold": 1, "model": "b", "confound_reliance_share": float("nan")},  # guarded-NaN fold, skipped
        ]
    )

    aggregated = interpretability.aggregate_confound_reliance(fold_shares)

    assert aggregated.iloc[0]["model"] == "b"  # lower mean share comes first
    assert aggregated.iloc[0]["n_folds_valid"] == 1
    assert aggregated.iloc[1]["model"] == "a"
    assert aggregated.iloc[1]["n_folds_valid"] == 2


def test_pairwise_metric_comparison_aligns_on_shared_valid_folds_and_reports_dropped():
    fold_shares = pd.DataFrame(
        [
            {"fold": 0, "model": "a", "confound_reliance_share": 0.10},
            {"fold": 1, "model": "a", "confound_reliance_share": 0.11},
            {"fold": 2, "model": "a", "confound_reliance_share": 0.09},
            {"fold": 0, "model": "b", "confound_reliance_share": 0.40},
            {"fold": 1, "model": "b", "confound_reliance_share": float("nan")},  # dropped for this pair
            {"fold": 2, "model": "b", "confound_reliance_share": 0.42},
        ]
    )

    pairwise = interpretability.pairwise_metric_comparison(fold_shares, ["a", "b"], "confound_reliance_share", 1)

    assert len(pairwise) == 1
    row = pairwise.iloc[0]
    assert row["n_folds_used"] == 2
    assert row["dropped_folds"] == "fold1:b"
    # a's share is clearly, consistently lower than b's.
    assert row["mean_diff_a_minus_b"] < 0


def test_determine_winner_lower_confound_reliance_share_wins():
    """The generic determine_winner() (Phase 7's own "beats every other
    candidate" rule, reused unchanged) already encodes lower-value-wins
    semantics - the same direction confound_reliance_share needs (leans least
    on the confound wins, section 9d). No inversion is needed in code."""
    pairwise = pd.DataFrame(
        [
            {"model_a": "xgboost", "model_b": "random_forest", "mean_diff_a_minus_b": -0.2, "significant_at_0.05": True},
            {"model_a": "xgboost", "model_b": "svm", "mean_diff_a_minus_b": -0.15, "significant_at_0.05": True},
            {"model_a": "random_forest", "model_b": "svm", "mean_diff_a_minus_b": 0.02, "significant_at_0.05": False},
        ]
    )
    winner = calibration.determine_winner(pairwise, ["xgboost", "random_forest", "svm"])
    assert winner == "xgboost"


def test_ece_tiebreak_winner_picks_lowest_ece():
    ece = pd.DataFrame(
        [
            {"model": "xgboost", "expected_calibration_error": 0.0251},
            {"model": "random_forest", "expected_calibration_error": 0.0470},
            {"model": "svm", "expected_calibration_error": 0.0390},
        ]
    )
    assert interpretability._ece_tiebreak_winner(ece, ["xgboost", "random_forest", "svm"]) == "xgboost"


def test_ece_tiebreak_winner_returns_none_on_exact_tie():
    ece = pd.DataFrame(
        [
            {"model": "xgboost", "expected_calibration_error": 0.03},
            {"model": "svm", "expected_calibration_error": 0.03},
        ]
    )
    assert interpretability._ece_tiebreak_winner(ece, ["xgboost", "svm"]) is None


def test_measure_deployment_cost_reports_expected_columns_and_dependency_flag():
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    features = ["informative_1", "informative_2", "noise_1"]

    final_models = {
        "random_forest": calibration.fit_calibrated_model("random_forest", {}, df[features], y, groups, inner_cv_folds=3),
        "svm": calibration.fit_calibrated_model(
            "svm", {"clf__C": 1.0, "clf__gamma": "scale"}, df[features], y, groups, inner_cv_folds=3
        ),
    }

    cost = interpretability.measure_deployment_cost(final_models, df[features].head(10))

    assert set(cost["model"]) == {"random_forest", "svm"}
    assert (cost["artifact_size_bytes"] > 0).all()
    assert (cost["inference_latency_seconds_for_sample"] >= 0).all()
    assert (cost["n_sample"] == 10).all()
    rf_row = cost[cost["model"] == "random_forest"].iloc[0]
    svm_row = cost[cost["model"] == "svm"].iloc[0]
    assert rf_row["extra_container_dependency"] == False  # noqa: E712
    assert svm_row["extra_container_dependency"] == False  # noqa: E712
