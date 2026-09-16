import numpy as np
import pandas as pd
import pytest
from scipy.stats import loguniform, ttest_1samp

from acoustic_model import baseline_models, feature_selection, hyperparameter_tuning


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


_SMALL_SEARCH_SPACES = {
    "logistic_regression": {"clf__C": loguniform(1e-2, 1e1)},
    "random_forest": {"clf__max_depth": [None, 4, 8]},
    "svm": {"clf__C": loguniform(1e-1, 1e1)},
    "xgboost": {"clf__max_depth": [2, 3, 4]},
}


def test_outer_folds_identical_to_phase_4_and_phase_5():
    """Load-bearing claim in the module docstring and config.py's
    TUNING_OUTER_CV_FOLDS comment - verified directly against the real committed
    feature matrix, not just asserted."""
    df4 = feature_selection._load_train_pool_features()
    y4 = (df4["class_label"] == "dementia").astype(int)
    groups4 = df4["subject_id"]
    folds4 = feature_selection._build_folds(df4, y4, groups4)

    df6 = hyperparameter_tuning._load_train_pool_features()
    y6 = (df6["class_label"] == "dementia").astype(int)
    groups6 = df6["subject_id"]
    folds6 = hyperparameter_tuning._build_outer_folds(df6, y6, groups6)

    assert df4.equals(df6)
    assert len(folds4) == len(folds6)
    for (train4, val4), (train6, val6) in zip(folds4, folds6):
        assert np.array_equal(train4, train6)
        assert np.array_equal(val4, val6)


def test_outer_folds_never_split_a_subjects_files(monkeypatch):
    monkeypatch.setattr(hyperparameter_tuning, "TUNING_OUTER_CV_FOLDS", 5)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    folds = hyperparameter_tuning._build_outer_folds(df, y, groups)

    for train_idx, val_idx in folds:
        train_subjects = set(df.iloc[train_idx]["subject_id"])
        val_subjects = set(df.iloc[val_idx]["subject_id"])
        assert train_subjects.isdisjoint(val_subjects)


def test_score_ranking_falls_back_to_decision_function_for_svm_without_probability():
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    scale_pos_weight = hyperparameter_tuning._compute_scale_pos_weight(y)
    pipeline = baseline_models._make_pipeline("svm", scale_pos_weight, svm_probability=False)
    pipeline.fit(df[["informative_1", "informative_2", "noise_1"]], y)

    assert not hasattr(pipeline, "predict_proba")
    scores = hyperparameter_tuning._score_ranking(pipeline, df[["informative_1", "informative_2", "noise_1"]])

    assert scores.shape == (len(df),)


def test_aggregate_stage_computes_mean_sd_and_se_distinctly():
    fold_scores = pd.DataFrame(
        [
            {"fold": 0, "model": "logistic_regression", "roc_auc": 0.8},
            {"fold": 1, "model": "logistic_regression", "roc_auc": 0.6},
        ]
    )

    aggregated = hyperparameter_tuning.aggregate_stage(fold_scores)

    row = aggregated[aggregated["model"] == "logistic_regression"].iloc[0]
    expected_sd = float(np.std([0.8, 0.6], ddof=1))
    assert row["mean_roc_auc"] == pytest.approx(0.7)
    assert row["std_roc_auc"] == pytest.approx(expected_sd)
    # SE must be SD/sqrt(n_folds), not equal to SD - the exact distinction section
    # 9b requires be kept visibly separate.
    assert row["se_roc_auc"] == pytest.approx(expected_sd / np.sqrt(hyperparameter_tuning.TUNING_OUTER_CV_FOLDS))
    assert row["se_roc_auc"] < row["std_roc_auc"]


def test_one_se_rule_keeps_only_models_within_one_se_of_the_best():
    aggregated = pd.DataFrame(
        [
            {"model": "a", "mean_roc_auc": 0.80, "std_roc_auc": 0.10, "se_roc_auc": 0.02},
            {"model": "b", "mean_roc_auc": 0.79, "std_roc_auc": 0.10, "se_roc_auc": 0.02},  # within one SE of a
            {"model": "c", "mean_roc_auc": 0.50, "std_roc_auc": 0.10, "se_roc_auc": 0.02},  # far below
        ]
    )

    survivors = hyperparameter_tuning.apply_one_se_rule(aggregated)

    assert set(survivors) == {"a", "b"}


def test_paired_comparison_diffs_per_fold_not_aggregate_means(monkeypatch, tmp_path):
    baseline_dir = tmp_path / "baseline_models"
    baseline_dir.mkdir()
    baseline_fold_metrics = pd.DataFrame(
        [
            {"fold": 0, "model": "svm", "roc_auc": 0.60},
            {"fold": 1, "model": "svm", "roc_auc": 0.70},
        ]
    )
    baseline_fold_metrics.to_csv(baseline_dir / "fold_metrics.csv", index=False)
    monkeypatch.setattr(hyperparameter_tuning, "BASELINE_MODELS_RESULTS_DIR", baseline_dir)

    stage2_scores = pd.DataFrame(
        [
            {"fold": 0, "model": "svm", "roc_auc": 0.75, "best_params": "{}"},  # +0.15
            {"fold": 1, "model": "svm", "roc_auc": 0.65, "best_params": "{}"},  # -0.05
        ]
    )

    paired = hyperparameter_tuning.paired_comparison(stage2_scores)

    assert paired.loc[paired["fold"] == 0, "diff"].iloc[0] == pytest.approx(0.15)
    assert paired.loc[paired["fold"] == 1, "diff"].iloc[0] == pytest.approx(-0.05)
    assert paired.loc[paired["fold"] == 0, "improved"].iloc[0]
    assert not paired.loc[paired["fold"] == 1, "improved"].iloc[0]

    summary = hyperparameter_tuning.summarize_paired_comparison(paired)
    row = summary[summary["model"] == "svm"].iloc[0]
    assert row["n_folds_improved"] == 1
    assert row["n_folds"] == 2
    assert row["mean_diff"] == pytest.approx(0.05)


def test_summarize_paired_comparison_t_stat_matches_scipy_directly():
    """This statistic is load-bearing for a real significance claim (see
    ml-development-spec.md section 9b's Phase 6 findings) - verified against
    scipy's own ttest_1samp directly, not just trusted to be correct."""
    paired = pd.DataFrame(
        [
            {"fold": 0, "model": "xgboost", "diff": 0.0339, "improved": True},
            {"fold": 1, "model": "xgboost", "diff": 0.0659, "improved": True},
            {"fold": 2, "model": "xgboost", "diff": -0.0037, "improved": False},
            {"fold": 3, "model": "xgboost", "diff": 0.0075, "improved": True},
            {"fold": 4, "model": "xgboost", "diff": 0.0439, "improved": True},
        ]
    )

    summary = hyperparameter_tuning.summarize_paired_comparison(paired)

    row = summary[summary["model"] == "xgboost"].iloc[0]
    expected_t, expected_p_two_tailed = ttest_1samp(paired["diff"].to_numpy(), 0.0)
    assert row["t_stat"] == pytest.approx(expected_t)
    assert row["p_value_two_tailed"] == pytest.approx(expected_p_two_tailed)
    assert row["p_value_one_tailed"] == pytest.approx(expected_p_two_tailed / 2)
    # A positive t-stat with a one-tailed p half the two-tailed p, both smaller
    # than the two-tailed p itself - the relationship a one-tailed test must have.
    assert row["p_value_one_tailed"] < row["p_value_two_tailed"]


def test_paired_comparison_returns_empty_when_baseline_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(hyperparameter_tuning, "BASELINE_MODELS_RESULTS_DIR", tmp_path / "does_not_exist")
    stage2_scores = pd.DataFrame([{"fold": 0, "model": "svm", "roc_auc": 0.7, "best_params": "{}"}])

    paired = hyperparameter_tuning.paired_comparison(stage2_scores)

    assert paired.empty
    assert hyperparameter_tuning.summarize_paired_comparison(paired).empty


def test_run_stage_and_final_lock_in_on_synthetic_data(monkeypatch):
    monkeypatch.setattr(hyperparameter_tuning, "TUNING_OUTER_CV_FOLDS", 3)
    monkeypatch.setattr(hyperparameter_tuning, "TUNING_INNER_CV_FOLDS", 2)
    monkeypatch.setattr(hyperparameter_tuning, "SEARCH_SPACES", _SMALL_SEARCH_SPACES)
    monkeypatch.setattr(baseline_models, "BASELINE_RF_N_ESTIMATORS", 30)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    selected_features = ["informative_1", "informative_2", "noise_1"]
    outer_folds = hyperparameter_tuning._build_outer_folds(df, y, groups)

    fold_scores = hyperparameter_tuning.run_stage(
        df, y, groups, selected_features, ["logistic_regression", "random_forest"], n_iter=2, outer_folds=outer_folds
    )

    assert set(fold_scores["model"]) == {"logistic_regression", "random_forest"}
    assert len(fold_scores) == 3 * 2
    assert (fold_scores["roc_auc"] > 0.7).all()  # clearly separable synthetic signal

    aggregated = hyperparameter_tuning.aggregate_stage(fold_scores)
    survivors = hyperparameter_tuning.apply_one_se_rule(aggregated)
    assert len(survivors) >= 1

    lock_in = hyperparameter_tuning.final_lock_in(df, y, groups, selected_features, survivors[0], n_iter=2)
    assert lock_in["model"] == survivors[0]
    assert "best_params" in lock_in
    assert "selection_score_not_a_performance_estimate" in lock_in
