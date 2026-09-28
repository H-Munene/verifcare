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
    """D7 candidate (b): dementia clips only from after onset or 0-5 years before; controls unaffected."""
    return (ages["label"] == 0) | ages["bucket"].astype(str).isin(["0", "5"])


def count_by_class(frame, label_names):
    grouped = frame.groupby("label").agg(clips=("file_id", "size"), subjects=("subject_id", "nunique"))
    return grouped.rename(index=label_names).reindex(list(label_names.values()), fill_value=0)
