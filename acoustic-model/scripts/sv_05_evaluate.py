"""SV5: score the holdout speakers once, with the rule frozen at SV4.

On development data (LibriSpeech) it reports figures and declares no pass or fail. On real data it
uses config.SV_FROZEN_RULE, claims the test set once, and gives a verdict against each target.
"""

import json

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, trials, visits_io

DEVELOPMENT = config.SV_DATASET in config.SV_DEV_DATASETS
OUT = config.SV_DATASET_RESULTS
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


def error_interval(error, pairs):
    """95% interval by resampling pairs. With no errors that collapses to zero, so the rule of three caps it."""
    low, high = metrics.rate_ci(error, pairs)
    return (low, 3 / len(error)) if not error.any() else (low, high)


def visit_outcomes(visits, rule):
    rows = []
    for visit in visits:
        rows.append({**{k: visit[k] for k in ("pair", "scenario")}, **decide.decide_visit(visit, rule["threshold"])})
    return pd.DataFrame(rows)


def visit_table(outcomes):
    rows = []
    for scenario in decide.SCENARIOS:
        group = outcomes[outcomes["scenario"] == scenario]
        genuine = scenario == decide.GENUINE
        error = ~group["passed"] if genuine else group["passed"]
        low, high = error_interval(error, group["pair"])
        rows.append({"scenario": scenario, "measure": "false reject" if genuine else "false accept", "visits": len(group),
                     "errors": int(error.sum()), "rate": percent(error.mean()), "95% interval": interval(low, high)})
    return pd.DataFrame(rows)


def frozen_rule():
    """Development data uses its own calibration file. Real data uses only the rule frozen in config.py."""
    chosen = json.loads((OUT / "04_calibration.json").read_text(encoding="utf-8"))
    if DEVELOPMENT:
        return chosen
    rule = config.SV_FROZEN_RULE
    if rule is None:
        raise SystemExit("config.SV_FROZEN_RULE is not set: freeze SV4's rule before scoring the test speakers")
    if any(rule[key] != chosen[key] for key in rule):
        raise SystemExit(f"config.SV_FROZEN_RULE {rule} differs from 04_calibration.json {chosen}")
    return rule


def verdict(outcomes):
    """Each target against the primary setting's measured rate on the test speakers, with its interval beside it."""
    rows = []
    for scenario in decide.SCENARIOS:
        group = outcomes[outcomes["scenario"] == scenario]
        genuine = scenario == decide.GENUINE
        error = ~group["passed"] if genuine else group["passed"]
        target = config.SV_TARGET_FALSE_REJECT if genuine else config.SV_TARGET_FALSE_ACCEPT
        low, high = error_interval(error, group["pair"])
        met = error.mean() <= target
        note = "" if not met or high <= target else ", but the interval reaches above it"
        rows.append({"scenario": scenario, "target": f"{'false reject' if genuine else 'false accept'} at most {percent(target)}",
                     "errors": f"{int(error.sum())} of {len(group)}", "rate": percent(error.mean()),
                     "95% interval": interval(low, high), "verdict": ("met" if met else "NOT met") + note})
    return pd.DataFrame(rows)


def main():
    rule = frozen_rule()
    plan = pd.read_csv(config.SV_DATASET_DIR / "visits.csv")

    scores = pd.read_csv(config.SV_DATASET_DIR / "trial_scores.csv")
    scores = scores[scores["split"] == "holdout"]
    trial = trial_table(scores)
    e1 = trial[(trial["model"] == "E1") & (trial["test seconds"] == config.SV_TRIAL_REPORT_SECONDS)]["EER"].iloc[0]
    clean = scores[scores["test_seconds"] == config.SV_TRIAL_REPORT_SECONDS]
    sanity = metrics.equal_error_rate(clean["label"], clean["e1"])[0] < SANITY_EER

    sections = []
    conditions = [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS]
    too_short = {}
    for condition in conditions:
        outcomes = visit_outcomes(visits_io.load("holdout", condition[0], plan), rule)
        if condition is config.SV_PRIMARY_CONDITION:
            primary = outcomes
        short = (outcomes[["caregiver", "dependant"]] == decide.TOO_SHORT).to_numpy()
        too_short[condition[0]] = f"{int(short.sum())} of {short.size}"
        sections += [f"### {condition[0]}", "", visit_table(outcomes).to_markdown(index=False), ""]

    timing = json.loads((OUT / "03_timing.json").read_text(encoding="utf-8")) if (OUT / "03_timing.json").exists() else {}
    if DEVELOPMENT:
        status = "**Development data only. English audiobook speech. Proves the code works, and judges no target.**"
        judged = ["Not produced for development data: DET curve, listening review, replay test, and any comparison with the targets."]
    else:
        status = ("**Test speakers, scored once with the rule frozen at SV4.** The targets are judged on the primary setting's "
                  "measured rates, with 95% intervals from resampling visit pairs. Where no errors were seen, the upper bound "
                  "is the rule of three (3 / visits).")
        judged = ["## Verdict against the targets, primary setting", "", verdict(primary).to_markdown(index=False), "",
                  "Not covered: replay (no pilot), elderly or impaired voices beyond the small older group, Swahili and English, "
                  "and real phones in homes (the noise is simulated). E1's published VoxCeleb1 accuracy is not reproduced."]
    lines = [f"# SV5 evaluation: {config.SV_DATASET}", "", status, "",
             f"Rule from calibration speakers: {json.dumps({k: rule[k] for k in ('threshold', 'min_clip_speech_seconds')})}.", "",
             "## Trials, clean audio, holdout speakers", "", trial.to_markdown(index=False), "",
             f"Pipeline check (E1 clean 30-second EER below {SANITY_EER:.0%}): {'met' if sanity else 'NOT met'}, at {e1}.", "",
             "## Simulated visits, holdout speakers", "", *sections,
             "## Recordings with too little speech to judge", "", pd.Series(too_short).to_markdown(), "",
             "## Median seconds per visit (both recordings) on this CPU", "", pd.Series(timing).round(2).to_markdown(), "",
             *judged, ""]
    # Everything is computed before the claim, so a crash above leaves the test set unused and unseen.
    used = trials.claim_test_set(config.SV_DATASET)
    assert used is not DEVELOPMENT, "a development run must never use up the real test set"
    (OUT / "05_evaluation.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
