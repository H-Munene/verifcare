import numpy as np
import pandas as pd
import pytest

from acoustic_model import baseline_models, feature_selection


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


def test_folds_never_split_a_subjects_files_across_train_and_validation(monkeypatch):
    monkeypatch.setattr(baseline_models, "BASELINE_MODEL_CV_FOLDS", 5)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    folds = baseline_models._build_folds(df, y, groups)

    for train_idx, val_idx in folds:
        train_subjects = set(df.iloc[train_idx]["subject_id"])
        val_subjects = set(df.iloc[val_idx]["subject_id"])
        assert train_subjects.isdisjoint(val_subjects)


def test_folds_are_identical_to_phase_4s_own_folds():
    """Load-bearing claim in config.BASELINE_MODEL_CV_FOLDS's docstring and this
    module's own docstring: Phase 5 must hold out the same subjects, fold-for-fold,
    that Phase 4 held out when it computed the out-of-fold permutation importance
    used to select the fixed feature subset. Verified directly against the real
    committed feature matrix, not just asserted, since both modules build their
    folds independently."""
    df4 = feature_selection._load_train_pool_features()
    y4 = (df4["class_label"] == "dementia").astype(int)
    groups4 = df4["subject_id"]
    folds4 = feature_selection._build_folds(df4, y4, groups4)

    df5 = baseline_models._load_train_pool_features()
    y5 = (df5["class_label"] == "dementia").astype(int)
    groups5 = df5["subject_id"]
    folds5 = baseline_models._build_folds(df5, y5, groups5)

    assert df4.equals(df5)
    assert len(folds4) == len(folds5)
    for (train4, val4), (train5, val5) in zip(folds4, folds5):
        assert np.array_equal(train4, train5)
        assert np.array_equal(val4, val5)


def test_evaluate_folds_runs_all_four_models_on_synthetic_data(monkeypatch):
    monkeypatch.setattr(baseline_models, "BASELINE_MODEL_CV_FOLDS", 3)
    monkeypatch.setattr(baseline_models, "BASELINE_RF_N_ESTIMATORS", 50)
    monkeypatch.setattr(baseline_models, "BASELINE_XGB_N_ESTIMATORS", 50)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    feature_columns = ["informative_1", "informative_2", "noise_1"]

    fold_metrics, pooled = baseline_models.evaluate_folds(df, y, groups, feature_columns)

    assert set(fold_metrics["model"]) == set(baseline_models.MODEL_NAMES)
    assert len(fold_metrics) == 3 * len(baseline_models.MODEL_NAMES)
    # A clearly separable synthetic signal should give every model a well-above-chance
    # mean ROC-AUC - a sanity check that the pipelines are actually fitting the signal,
    # not just running without error.
    mean_auc_by_model = fold_metrics.groupby("model")["roc_auc"].mean()
    assert (mean_auc_by_model > 0.8).all()

    # Pooled predictions cover every train_pool subject exactly once per model.
    for model_name in baseline_models.MODEL_NAMES:
        assert set(pooled[model_name]["subject_id"]) == set(df["subject_id"])
        assert len(pooled[model_name]) == len(df)


def test_youden_threshold_metrics_recovers_a_clean_separation():
    y_true = np.array([0, 0, 0, 1, 1, 1])
    y_score = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])

    result = baseline_models._youden_threshold_metrics(y_true, y_score)

    assert result["sensitivity_youden"] == 1.0
    assert result["specificity_youden"] == 1.0
    assert 0.3 < result["youden_threshold"] <= 0.7


def test_sensitivity_at_fixed_specificity_matches_manual_roc_lookup():
    # Constructed so specificity=1.0 is achievable at fpr=0 (tpr=0.5), and
    # specificity=0.5 is achievable at fpr=0.5 (tpr=1.0).
    y_true = np.array([0, 0, 1, 1])
    y_score = np.array([0.1, 0.4, 0.3, 0.9])

    sensitivity_at_100 = baseline_models._sensitivity_at_fixed_specificity(y_true, y_score, 1.0)
    sensitivity_at_50 = baseline_models._sensitivity_at_fixed_specificity(y_true, y_score, 0.5)

    assert sensitivity_at_100 == 0.5
    assert sensitivity_at_50 == 1.0


def test_sensitivity_at_fixed_specificity_returns_nan_when_unreachable():
    y_true = np.array([0, 0, 1, 1])
    y_score = np.array([0.4, 0.9, 0.1, 0.6])  # a poorly-ordered, non-monotonic ROC

    result = baseline_models._sensitivity_at_fixed_specificity(y_true, y_score, 1.01)

    assert np.isnan(result)


def _sample_std(values):
    # pandas' groupby(...).agg("std") uses ddof=1 (sample std), matched here so the
    # test isn't silently checking the wrong formula.
    return float(np.std(values, ddof=1))


def test_aggregate_metrics_computes_mean_and_std_per_model():
    fold_metrics = pd.DataFrame(
        [
            {
                "fold": 0, "model": "logistic_regression", "roc_auc": 0.8, "pr_auc": 0.7, "brier_score": 0.1,
                "sensitivity_at_fixed_specificity": 0.6, "sensitivity_youden": 0.7, "specificity_youden": 0.7,
                "f1_youden": 0.7, "balanced_accuracy_youden": 0.7,
            },
            {
                "fold": 1, "model": "logistic_regression", "roc_auc": 0.6, "pr_auc": 0.5, "brier_score": 0.2,
                "sensitivity_at_fixed_specificity": 0.4, "sensitivity_youden": 0.5, "specificity_youden": 0.5,
                "f1_youden": 0.5, "balanced_accuracy_youden": 0.5,
            },
        ]
    )

    aggregated = baseline_models.aggregate_metrics(fold_metrics)

    row = aggregated[aggregated["model"] == "logistic_regression"].iloc[0]
    assert row["roc_auc_mean"] == 0.7
    assert row["roc_auc_std"] == _sample_std([0.8, 0.6])


def test_trivial_baseline_brier_matches_bernoulli_variance():
    y = pd.Series([1, 1, 0, 0, 0])  # p = 0.4

    result = baseline_models._trivial_baseline_brier(y)

    assert result == pytest.approx(0.4 * 0.6)


def test_pooled_calibration_ece_is_zero_for_perfectly_calibrated_predictions():
    pooled = {
        "logistic_regression": pd.DataFrame(
            {
                "fold": [0, 0, 0, 0],
                "subject_id": ["s1", "s2", "s3", "s4"],
                "y_true": [0, 0, 1, 1],
                "y_prob": [0.0, 0.0, 1.0, 1.0],
            }
        )
    }

    curve_df, ece_df = baseline_models.pooled_calibration(pooled)

    ece_row = ece_df[ece_df["model"] == "logistic_regression"].iloc[0]
    assert ece_row["expected_calibration_error"] == 0.0
    assert ece_row["n_pooled_predictions"] == 4
    assert len(curve_df) > 0
