import pandas as pd

from acoustic_model.splits import EXCLUDED_SPLIT, TEST_SPLIT, TRAIN_POOL_SPLIT, assign_splits, build_subject_usability


def _subject_df(n_dementia=40, n_no_dementia=60, n_unusable=3):
    rows = []
    for i in range(n_dementia):
        rows.append({"subject_id": f"subj_d{i:03d}", "class_label": "dementia", "usable": True})
    for i in range(n_no_dementia):
        rows.append({"subject_id": f"subj_n{i:03d}", "class_label": "no_dementia", "usable": True})
    for i in range(n_unusable):
        rows.append({"subject_id": f"subj_u{i:03d}", "class_label": "dementia", "usable": False})
    return pd.DataFrame(rows)


def test_excluded_subjects_never_enter_train_or_test():
    split_df = assign_splits(_subject_df())

    excluded = split_df[split_df["subject_id"].str.startswith("subj_u")]
    assert (excluded["split"] == EXCLUDED_SPLIT).all()


def test_split_is_stratified_by_class_label():
    split_df = assign_splits(_subject_df(n_dementia=40, n_no_dementia=60), test_fraction=0.2)

    test_df = split_df[split_df["split"] == TEST_SPLIT]
    train_df = split_df[split_df["split"] == TRAIN_POOL_SPLIT]

    # 20% of 40 dementia = 8, 20% of 60 no_dementia = 12.
    assert (test_df["class_label"] == "dementia").sum() == 8
    assert (test_df["class_label"] == "no_dementia").sum() == 12
    assert (train_df["class_label"] == "dementia").sum() == 32
    assert (train_df["class_label"] == "no_dementia").sum() == 48


def test_no_subject_appears_in_both_train_pool_and_test():
    split_df = assign_splits(_subject_df())

    train_ids = set(split_df[split_df["split"] == TRAIN_POOL_SPLIT]["subject_id"])
    test_ids = set(split_df[split_df["split"] == TEST_SPLIT]["subject_id"])

    assert train_ids.isdisjoint(test_ids)


def test_assign_splits_is_deterministic_for_a_fixed_seed():
    df = _subject_df()

    first = assign_splits(df, random_seed=123)
    second = assign_splits(df, random_seed=123)

    assert first.sort_values("subject_id")["split"].tolist() == second.sort_values("subject_id")["split"].tolist()


def test_build_subject_usability_flags_subjects_with_zero_included_files():
    duration_report = pd.DataFrame(
        [
            {"subject_id": "subj_001", "class_label": "dementia", "included": True},
            {"subject_id": "subj_001", "class_label": "dementia", "included": False},
            {"subject_id": "subj_002", "class_label": "no_dementia", "included": False},
        ]
    )

    subject_df = build_subject_usability(duration_report)

    assert subject_df.set_index("subject_id").loc["subj_001", "usable"]
    assert not subject_df.set_index("subject_id").loc["subj_002", "usable"]
