import numpy as np
import pandas as pd

from mzazi_acoustic.data_processing import eligibility

AGES = pd.DataFrame({
    "file_id": ["d_old", "d_cross55", "d_cross70", "d_unknown", "d_young", "c_1", "c_2", "c_3"],
    "subject_id": ["a", "b", "c", "d", "e", "f", "f", "f"],
    "label": [1, 1, 1, 1, 1, 0, 0, 0],
    "bucket": ["0", "15", "5", "5", "15", "1", "2", "3"],
    "age_low": [72, 52, 67, np.nan, 40, np.nan, 55, 70],
    "age_high": [80, 57, 72, np.nan, 45, 55, 70, np.nan],
})


def kept(mask):
    return set(AGES.loc[mask, "file_id"])


def test_primary_dataset_keeps_only_clips_wholly_at_55_or_over():
    # A range crossing 55 or an unknown age can't be shown to qualify; one crossing 70 is still 55+.
    assert kept(eligibility.primary_dataset(AGES)) == {"d_old", "d_cross70", "c_2", "c_3"}


def test_over_70_subset():
    assert kept(eligibility.over_70_sensitivity(AGES)) == {"d_old", "c_3"}


def test_training_timing_drops_only_the_10_to_15_year_clips_which_go_to_trajectory():
    training = kept(eligibility.within_10_years_of_onset(AGES))
    trajectory = kept(eligibility.trajectory_only(AGES))
    assert trajectory == {"d_cross55", "d_young"}
    assert training.isdisjoint(trajectory)
    assert training | trajectory == set(AGES["file_id"])


def test_near_onset_only_touches_dementia_clips():
    assert kept(eligibility.near_onset_only(AGES)) == {"d_old", "d_cross70", "d_unknown", "c_1", "c_2", "c_3"}
