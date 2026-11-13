"""Leakage guards and visit plans: the parts that would quietly flatter the results if wrong."""

import numpy as np
import pandas as pd
import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, trials

SR = config.SV_SAMPLE_RATE


def speakers(n=40):
    return pd.DataFrame({
        "speaker": [f"s{i}" for i in range(n)],
        "sex": ["F" if i % 2 else "M" for i in range(n)],
        "eligible": [i % 5 != 0 for i in range(n)],
        "enrol_recording": [f"s{i}_a" for i in range(n)],
        "test_recording": [f"s{i}_b" for i in range(n)],
    })


def test_a_locked_test_person_is_refused():
    with pytest.raises(ValueError):
        trials.assert_no_locked_people(["S1", "S2"], {"S2"})
    trials.assert_no_locked_people(["S1"], {"S2"})


def test_locked_people_are_read_from_the_test_rows_only(tmp_path):
    path = tmp_path / "splits.csv"
    pd.DataFrame({"subject_id": ["a", "b"], "split": ["train", "test"]}).to_csv(path, index=False)
    assert trials.locked_people(path) == {"b"}


def test_the_split_keeps_every_speaker_on_one_side():
    split = trials.speaker_split(speakers())
    assert split.groupby("speaker")["split"].nunique().max() == 1
    assert set(split["split"]) == {"calibration", "holdout"}


def test_a_speaker_on_both_sides_is_refused():
    with pytest.raises(ValueError):
        trials.assert_speaker_disjoint(pd.DataFrame({"speaker": ["a", "a"], "split": ["calibration", "holdout"]}))


def test_one_recording_for_enrolment_and_test_is_refused():
    table = speakers()
    table.loc[1, "test_recording"] = table.loc[1, "enrol_recording"]
    with pytest.raises(ValueError):
        trials.verification_trials(table)


def test_trials_pair_only_the_same_sex_and_mark_targets():
    table = speakers()
    result = trials.verification_trials(table)
    sex = dict(zip(table["speaker"], table["sex"]))
    assert (result["enrol"].map(sex) == result["test"].map(sex)).all()
    assert ((result["enrol"] == result["test"]) == (result["label"] == 1)).all()


def test_every_visit_holds_the_intended_people():
    plan = trials.plan_visits(speakers())
    assert set(plan["scenario"]) == set(decide.SCENARIOS)
    for row in plan.itertuples():
        if row.scenario == decide.GENUINE:
            assert (row.first, row.second) == (row.caregiver, row.dependant)
        elif row.scenario == "caregiver_alone":
            assert row.first == row.second == row.caregiver
        elif row.scenario == "different_dependant":
            assert row.first == row.caregiver and row.second not in (row.caregiver, row.dependant)
        else:
            assert row.second == row.dependant and row.first not in (row.caregiver, row.dependant)


def test_pairs_are_independent():
    plan = trials.plan_visits(speakers())
    genuine = plan[plan["scenario"] == decide.GENUINE]
    people = [*genuine["caregiver"], *genuine["dependant"]]
    assert len(people) == len(set(people))


def test_the_two_recordings_come_from_separate_parts_of_the_audio():
    pool = np.arange(SR * 20, dtype=np.float32)
    first, second = trials.clip_from_pool(pool, 0, 8.5), trials.clip_from_pool(pool, 1, 8.5)
    assert len(first) == len(second) == round(8.5 * SR)
    assert first[-1] < second[0]


def test_too_little_audio_for_a_recording_is_refused():
    with pytest.raises(ValueError):
        trials.clip_from_pool(np.zeros(SR * 10, dtype=np.float32), 1, 8.5)


def test_a_development_dataset_leaves_the_marker_unset(tmp_path):
    marker = tmp_path / "used.json"
    assert trials.claim_test_set("librispeech", marker) is False
    assert not marker.exists()


def test_a_real_dataset_can_only_be_scored_once(tmp_path):
    marker = tmp_path / "used.json"
    assert trials.claim_test_set("afrivoices", marker) is True
    with pytest.raises(RuntimeError):
        trials.claim_test_set("afrivoices", marker)
