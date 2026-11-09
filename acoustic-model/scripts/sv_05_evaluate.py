"""SV5 code path, run on the LibriSpeech holdout speakers. Development data only.

Reports figures and declares no pass or fail. The real evaluation runs this path once, on Kenyan
speakers, with a rule calibrated on Kenyan speakers.
"""

import json

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, segment, trials, visits_io

DATASET = "librispeech"
OUT = config.SV_DEV_RESULTS
SANITY_EER = 0.05


def percent(value):
    return f"{value * 100:.1f}%"


def interval(low, high):
    return f"{percent(low)} to {percent(high)}"


def trial_table(scores):
    rows = []
    for length, group in scores.groupby("test_seconds"):
        for model in ("e1", "b0"):
            eer, _ = metrics.equal_error_rate(group["label"], group[model])
            low, high = metrics.eer_ci(group["label"], group[model], group["enrol"])
            rows.append({"model": model.upper(), "test seconds": length, "EER": percent(eer),
                         "95% interval": interval(low, high), "minDCF": round(metrics.min_dcf(group["label"], group[model]), 3)})
    return pd.DataFrame(rows)


def visit_outcomes(visits, rule):
    rows = []
    for visit in visits:
        labels = segment.label_windows(visit["caregiver_scores"], visit["dependant_scores"], rule["threshold"])
        rows.append({**{k: visit[k] for k in ("pair", "scenario")},
                     **decide.decide(labels, rule["caregiver_seconds"], rule["dependant_seconds"])})
    return pd.DataFrame(rows)


def visit_table(outcomes):
    rows = []
    for scenario in decide.SCENARIOS:
        group = outcomes[outcomes["scenario"] == scenario]
        genuine = scenario == decide.GENUINE
        error = ~group["passed"] if genuine else group["passed"]
        low, high = metrics.rate_ci(error, group["pair"])
        rows.append({"scenario": scenario, "measure": "false reject" if genuine else "false accept", "visits": len(group),
                     "errors": int(error.sum()), "rate": percent(error.mean()), "95% interval": interval(low, high)})
    return pd.DataFrame(rows)


def main():
    used = trials.claim_test_set(DATASET)
    assert used is False, "the LibriSpeech run must not use up the real test set"
    rule = json.loads((OUT / "04_calibration.json").read_text(encoding="utf-8"))
    plan = pd.read_csv(config.SV_DATA_DIR / "librispeech_visits.csv")

    scores = pd.read_csv(config.SV_DATA_DIR / "trial_scores.csv")
    scores = scores[scores["split"] == "holdout"]
    trial = trial_table(scores)
    e1 = trial[(trial["model"] == "E1") & (trial["test seconds"] == config.SV_VISIT_SECONDS)]["EER"].iloc[0]
    clean = scores[scores["test_seconds"] == config.SV_VISIT_SECONDS]
    sanity = metrics.equal_error_rate(clean["label"], clean["e1"])[0] < SANITY_EER

    sections = []
    conditions = [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS]
    unknown = {}
    for condition in conditions:
        outcomes = visit_outcomes(visits_io.load("holdout", condition[0], plan), rule)
        unknown[condition[0]] = float(outcomes["unknown_seconds"].mean())
        sections += [f"### {condition[0]}", "", visit_table(outcomes).to_markdown(index=False), ""]

    timing = json.loads((OUT / "03_timing.json").read_text(encoding="utf-8")) if (OUT / "03_timing.json").exists() else {}
    lines = ["# SV5 evaluation code path: LibriSpeech", "",
             "**Development data only. English audiobook speech. Proves the code works, and judges no target.**", "",
             f"Rule from calibration speakers: {json.dumps({k: rule[k] for k in ('threshold', 'caregiver_seconds', 'dependant_seconds')})}.", "",
             "## Trials, clean audio, holdout speakers", "", trial.to_markdown(index=False), "",
             f"Pipeline check (E1 clean 30-second EER below {SANITY_EER:.0%}): {'met' if sanity else 'NOT met'}, at {e1}.", "",
             "## Simulated visits, holdout speakers", "", *sections,
             "## Mean unknown speech per visit, seconds", "", pd.Series(unknown).round(2).to_markdown(), "",
             "## Median seconds per 30-second recording on this CPU", "", pd.Series(timing).round(2).to_markdown(), "",
             "Not produced for development data: DET curve, listening review, replay test, and any comparison with the targets.", ""]
    (OUT / "05_evaluation.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
