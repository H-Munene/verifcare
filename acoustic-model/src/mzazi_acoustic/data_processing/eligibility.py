"""Which recordings each dataset definition keeps (decisions D6 and D7, PLAN.md Stage 2).

Each rule takes rows of results/01_data_collection/age_at_recording.csv and returns a boolean mask.
An age rule keeps a clip only if its *whole* age range is inside the band. So a dementia clip
whose range crosses 55 (e.g. 52-57) is dropped from the 55+ dataset, and a clip with an unknown
age is dropped from any age-restricted set: its age can't be shown to qualify.
"""


def wholly_at_least(ages, minimum):
    """Dementia: age_low >= minimum. Controls: their band's lower edge >= minimum."""
    control_band_low = ages["bucket"].astype(str).map({"1": 0, "2": 55, "3": 70})
    dementia_ok = (ages["label"] == 1) & (ages["age_low"] >= minimum)
    control_ok = (ages["label"] == 0) & (control_band_low >= minimum)
    return dementia_ok | control_ok


def primary_dataset(ages):
    """D6 option A (decided 2026-09-28): both classes wholly aged 55 or over."""
    return wholly_at_least(ages, 55)


def over_70_sensitivity(ages):
    """D6 option B, pre-registered as a Stage 5.2 sensitivity subset only: wholly over 70."""
    return wholly_at_least(ages, 70)


def near_onset_only(ages):
    """Dementia clips only from after onset or 0-5 years before; controls unaffected.

    Not the training set (D7 chose option c); used for the pre-registered 5.2 sensitivity analysis.
    """
    return (ages["label"] == 0) | ages["bucket"].astype(str).isin(["0", "5"])


def within_10_years_of_onset(ages):
    """D7 option (c), decided 2026-09-28: dementia clips from after onset to 10 years before.

    The 10-15-year clips are the most likely to show no signs yet, and are the oldest recordings.
    They go only to the Stage 5 trajectory analysis, never to training or selection.
    """
    return (ages["label"] == 0) | ages["bucket"].astype(str).isin(["0", "5", "10"])


def trajectory_only(ages):
    """Dementia clips 10-15 years before onset: scored in Stage 5's trajectory analysis only."""
    return (ages["label"] == 1) & (ages["bucket"].astype(str) == "15")


def count_by_class(frame, label_names):
    grouped = frame.groupby("label").agg(clips=("file_id", "size"), subjects=("subject_id", "nunique"))
    return grouped.rename(index=label_names).reindex(list(label_names.values()), fill_value=0)
