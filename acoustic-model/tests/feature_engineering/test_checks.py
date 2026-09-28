"""Stage 3.3 check rules on synthetic tables with known answers."""

import runpy
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering import checks

RNG = np.random.default_rng(0)


def test_redundancy_keeps_the_first_listed_feature():
    a = RNG.normal(size=200)
    table = pd.DataFrame({"a": a, "b": a + RNG.normal(scale=0.01, size=200), "c": RNG.normal(size=200)})
    kept, dropped = checks.redundancy(table, ["a", "b", "c"])
    assert kept == ["a", "c"]
    assert list(dropped["dropped"]) == ["b"] and list(dropped["kept"]) == ["a"]


def test_exact_three_feature_dependency_is_caught_by_rank_not_pairwise_r():
    b, c, d = RNG.normal(size=(3, 300))
    table = pd.DataFrame({"b": b, "c": c, "d": d, "a": b + c + 5})  # a listed last
    kept, _ = checks.redundancy(table, ["b", "c", "d", "a"])
    assert kept == ["b", "c", "d", "a"]  # every pairwise |r| is ~0.71, under 0.9
    kept, outcome, _ = checks.dependency(table, kept)
    assert kept == ["b", "c", "d"]
    assert outcome.set_index("feature").loc["a", "kept"] == False  # noqa: E712
    assert outcome["rank_before"].iloc[0] == 3


def test_vif_matches_one_over_one_minus_r_squared():
    x1 = RNG.normal(size=5000)
    x2 = 0.8 * x1 + 0.6 * RNG.normal(size=5000)  # corr(x1, x2) ~ 0.8, so R^2 ~ 0.64
    table = pd.DataFrame({"x1": x1, "x2": x2})
    r = np.corrcoef(x1, x2)[0, 1]
    result = checks.vif(table, ["x1", "x2"])
    assert result["vif"].to_numpy() == pytest.approx(1 / (1 - r**2), rel=1e-3)


def test_relative_pair_differences_formula_and_zero_pairs():
    assert checks.relative_pair_differences([1.0, 3.0]) == [pytest.approx(1.0)]  # |1-3| / 2
    assert checks.relative_pair_differences([0.0, 0.0]) == []  # both zero: skipped
    assert checks.relative_pair_differences([0.0, 2.0]) == [pytest.approx(2.0)]


def multi_clip_table(n_subjects, same_band):
    rows = []
    for s in range(n_subjects):
        bands = ["55-70", "55-70"] if same_band else ["55-70", ">70"]
        for k, band in enumerate(bands):
            rows.append({"subject_id": f"S{s}", "age_band": band, "f": 1.0 + k})  # pair diff = 1 / 1.5
    return pd.DataFrame(rows)


def test_benchmark_cascade_levels():
    minimum = 5
    _, level = checks.within_person_benchmark(multi_clip_table(5, same_band=True), ["f"], minimum)
    assert level == 1
    result, level = checks.within_person_benchmark(multi_clip_table(5, same_band=False), ["f"], minimum)
    assert level == 2 and result["benchmark"].iloc[0] == pytest.approx(1 / 1.5)
    result, level = checks.within_person_benchmark(multi_clip_table(4, same_band=False), ["f"], minimum)
    assert level == 3 and result["benchmark"].isna().all()


def test_flag_rule_uses_the_smaller_of_benchmark_and_ten_percent():
    shift = pd.DataFrame({"condition": "bandpass", "feature": ["p", "q", "r"],
                          "median_relative_change": [0.06, -0.12, 0.09]})
    benchmark = pd.DataFrame({"feature": ["p", "q", "r"], "benchmark": [0.05, 0.40, np.nan]})
    flags = checks.degradation_flags(shift, benchmark, features=["p", "q", "r"]).set_index("feature")
    assert flags.loc["p", "flagged"]  # 6 % > benchmark 5 %
    assert flags.loc["q", "flagged"]  # |-12 %| > 10 % cap, even though benchmark is 40 %
    assert not flags.loc["r", "flagged"]  # no benchmark: 10 % fallback, 9 % stays under
    assert flags.loc["r", "tolerance"] == pytest.approx(0.10)


def test_confound_removal_touches_family_b_only():
    n = 60
    proxy = RNG.normal(size=n)
    family_a, family_b = config.FAMILY_A_FEATURES[0], config.FAMILY_B_FEATURES[0]
    table = pd.DataFrame({"file_id": [f"f{i}" for i in range(n)], "subject_id": [f"S{i}" for i in range(n)],
                          "label": [i % 2 for i in range(n)], family_a: proxy, family_b: proxy,
                          "noise_floor_dbfs": proxy})
    result = checks.channel_confound(table, [family_a, family_b], proxies=["noise_floor_dbfs"]).set_index("feature")
    assert result.loc[family_b, "remove"]
    assert not result.loc[family_a, "remove"] and result.loc[family_a, "note"] == checks.CIRCULAR_PROXY_NOTE


def test_checks_script_exits_while_its_gate_is_closed(monkeypatch):
    monkeypatch.setattr(config, "DETECTOR_SIGNED_OFF", False)
    script = Path(__file__).resolve().parents[2] / "scripts" / "03b_checks.py"
    with pytest.raises(SystemExit, match="signed off"):
        runpy.run_path(str(script), run_name="__main__")
