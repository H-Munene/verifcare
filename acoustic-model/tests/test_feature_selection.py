import numpy as np
import pandas as pd

from acoustic_model import feature_selection


def _synthetic_train_pool(n_subjects=30, files_per_subject=3, seed=0):
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
                    "informative_1": label_signal + rng.normal(scale=0.3),
                    "informative_2": label_signal * 2 + rng.normal(scale=0.5),
                    "noise_1": rng.normal(),
                    "noise_2": rng.normal(),
                    "noise_3": rng.normal(),
                    "noise_4": rng.normal(),
                }
            )
    return pd.DataFrame(rows)


def test_folds_never_split_a_subjects_files_across_train_and_validation(monkeypatch):
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_CV_FOLDS", 5)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    folds = feature_selection._build_folds(df, y, groups)

    for train_idx, val_idx in folds:
        train_subjects = set(df.iloc[train_idx]["subject_id"])
        val_subjects = set(df.iloc[val_idx]["subject_id"])
        assert train_subjects.isdisjoint(val_subjects)


def test_informative_features_rank_above_noise_features(monkeypatch):
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_CV_FOLDS", 5)
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_RF_N_ESTIMATORS", 100)
    monkeypatch.setattr(feature_selection, "PERMUTATION_IMPORTANCE_N_REPEATS", 5)
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    feature_columns = ["informative_1", "informative_2", "noise_1", "noise_2", "noise_3", "noise_4"]

    fold_importances = feature_selection.compute_fold_importances(df, y, groups, feature_columns)
    aggregated = feature_selection.aggregate_importance(fold_importances)

    top_two = aggregated.head(2)["feature"].tolist()
    assert set(top_two) == {"informative_1", "informative_2"}


def test_choose_k_prefers_smaller_k_within_one_se_of_the_best(monkeypatch):
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_CV_FOLDS", 5)
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_RF_N_ESTIMATORS", 100)
    monkeypatch.setattr(feature_selection, "PERMUTATION_IMPORTANCE_N_REPEATS", 5)
    monkeypatch.setattr(feature_selection, "FEATURE_SELECTION_CANDIDATE_K_VALUES", (2, 4, 6))
    df = _synthetic_train_pool()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    feature_columns = ["informative_1", "informative_2", "noise_1", "noise_2", "noise_3", "noise_4"]

    fold_importances = feature_selection.compute_fold_importances(df, y, groups, feature_columns)
    chosen_k, k_scores = feature_selection.choose_k(df, y, groups, fold_importances)

    assert chosen_k in (2, 4, 6)
    assert set(k_scores["k"]) == {2, 4, 6}
    # With only 2 truly informative features, k=2 should score at least as well as
    # larger k - the one-SE rule should not need to reach past it.
    assert chosen_k == 2


def test_selection_stability_counts_folds_correctly():
    fold_importances = pd.DataFrame(
        [
            {"fold": 0, "feature": "a", "importance_mean": 0.5, "importance_std": 0.1},
            {"fold": 0, "feature": "b", "importance_mean": 0.1, "importance_std": 0.1},
            {"fold": 1, "feature": "a", "importance_mean": 0.4, "importance_std": 0.1},
            {"fold": 1, "feature": "b", "importance_mean": 0.6, "importance_std": 0.1},
        ]
    )

    stability = feature_selection.selection_stability(fold_importances, chosen_k=1, n_folds=2)

    a_row = stability[stability["feature"] == "a"].iloc[0]
    b_row = stability[stability["feature"] == "b"].iloc[0]
    assert a_row["times_selected"] == 1  # top-1 in fold 0 only
    assert b_row["times_selected"] == 1  # top-1 in fold 1 only
