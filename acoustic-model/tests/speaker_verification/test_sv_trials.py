"""Leakage guards and simulated visits: the parts that would quietly flatter the results if wrong."""

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
            assert row.first == row.caregiver and pd.isna(row.second)
        elif row.scenario == "different_dependant":
            assert row.first == row.caregiver and row.second not in (row.caregiver, row.dependant)
        else:
            assert row.second == row.dependant and row.first not in (row.caregiver, row.dependant)


def test_pairs_are_independent():
    plan = trials.plan_visits(speakers())
    genuine = plan[plan["scenario"] == decide.GENUINE]
    people = [*genuine["caregiver"], *genuine["dependant"]]
    assert len(people) == len(set(people))


def pools():
    rng = np.random.default_rng(0)
    return rng.standard_normal(SR * 45).astype(np.float32) * 0.1, rng.standard_normal(SR * 45).astype(np.float32) * 0.1


@pytest.mark.parametrize("share", [0.2, 0.4, 0.6])
def test_simulated_visit_has_the_intended_shares_and_length(share):
    first, second = pools()
    audio, turns = trials.compose_visit(first, second, share, np.random.default_rng(1))
    assert len(audio) == SR * config.SV_VISIT_SECONDS
    assert {who for who, _, _ in turns} == {0, 1}
    spoken = [sum(end - start for who, start, end in turns if who == person) for person in (0, 1)]
    assert spoken[1] / sum(spoken) == pytest.approx(share, abs=0.03)


def test_a_person_alone_produces_one_speaker():
    first, _ = pools()
    _, turns = trials.compose_visit(first, None, 0.4, np.random.default_rng(1))
    assert {who for who, _, _ in turns} == {0}


def test_overlap_makes_consecutive_turns_share_samples():
    first, second = pools()
    _, turns = trials.compose_visit(first, second, 0.4, np.random.default_rng(1), overlap_seconds=0.3)
    assert any(later[1] < earlier[2] for earlier, later in zip(turns, turns[1:]))


def test_a_development_dataset_leaves_the_marker_unset(tmp_path):
    marker = tmp_path / "used.json"
    assert trials.claim_test_set("librispeech", marker) is False
    assert not marker.exists()


def test_a_real_dataset_can_only_be_scored_once(tmp_path):
    marker = tmp_path / "used.json"
    assert trials.claim_test_set("afrivoices", marker) is True
    with pytest.raises(RuntimeError):
        trials.claim_test_set("afrivoices", marker)
