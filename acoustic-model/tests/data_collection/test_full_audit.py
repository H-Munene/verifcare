"""The full listening audit: session draw, the pre-registered D1 rule, and listener agreement."""

import numpy as np
import pandas as pd

from mzazi_acoustic.data_collection import listening_audit as la


def clips(n=100):
    return pd.DataFrame({"file_id": [f"f{i}" for i in range(n)], "subject_id": [f"s{i // 2}" for i in range(n)],
                         "label": [int(i < n // 3) for i in range(n)], "role": "training_pool"})


def test_sessions_cover_every_clip_once_plus_a_hidden_10_percent():
    s1, s2 = la.draw_full_audit(clips(), 0.10, seed=1)
    assert sorted(s1["file_id"]) == sorted(clips()["file_id"])
    assert len(s2) == 10 and s2["file_id"].isin(s1["file_id"]).all() and s2["file_id"].is_unique
    # ids say nothing about class or about which session-1 clip a repeat is
    assert s1["audit_id"].str.fullmatch(r"aud_\d{3}").all() and s2["audit_id"].str.fullmatch(r"rep_\d{2}").all()


def people(dementia_other, dementia_n, control_other, control_n, dementia_left=None):
    rows = [{"subject_id": f"d{i}", "label": 1, "any_other_voice": i < dementia_other,
             "has_single_speaker_clip": True} for i in range(dementia_n)]
    rows += [{"subject_id": f"c{i}", "label": 0, "any_other_voice": i < control_other,
              "has_single_speaker_clip": True} for i in range(control_n)]
    table = pd.DataFrame(rows)
    if dementia_left is not None:  # people who'd lose every clip under (c)
        lost = table.index[(table.label == 1)][dementia_left:]
        table.loc[lost, "has_single_speaker_clip"] = False
    return table


def test_d1_picks_c_when_fisher_says_the_rates_differ():
    result = la.d1_decision(people(20, 54, 5, 118), alpha=0.05, gap=0.10, min_dementia_people=40)
    assert result["fisher_p"] < 0.05 and result["decision"] == "c"


def test_d1_picks_c_on_the_gap_alone():
    # 3/10 vs 1/10: Fisher p ~0.58 but a 20-point gap
    result = la.d1_decision(people(3, 10, 1, 10), alpha=0.05, gap=0.10, min_dementia_people=5)
    assert result["fisher_p"] > 0.05 and result["decision"] == "c"


def test_d1_picks_a_when_rates_are_similar():
    result = la.d1_decision(people(5, 54, 11, 118), alpha=0.05, gap=0.10, min_dementia_people=40)
    assert not result["differs_clearly"] and result["decision"] == "a"


def test_d1_falls_back_to_a_when_c_would_leave_too_few_dementia_people():
    result = la.d1_decision(people(20, 54, 5, 118, dementia_left=35), alpha=0.05, gap=0.10, min_dementia_people=40)
    assert result["differs_clearly"] and not result["c_viable"] and result["decision"] == "a"


def test_agreement_reports_percent_and_kappa():
    first = pd.DataFrame({"other_voices": ["yes", "no", "no", "yes"], "music": ["no"] * 4})
    second = pd.DataFrame({"other_voices": ["yes", "no", "yes", "yes"], "music": ["no"] * 4})
    result = la.agreement(first, second, columns=["other_voices", "music"]).set_index("column")
    assert result.loc["other_voices", "percent_agreement"] == 75.0
    assert 0 < result.loc["other_voices", "cohens_kappa"] < 1
    assert result.loc["music", "percent_agreement"] == 100.0 and np.isnan(result.loc["music", "cohens_kappa"])
