"""SV4: choose the match threshold on calibration speakers only, then freeze it.

On development data the rule is written to the results folder and deliberately NOT to config.py: it
says nothing about Kenyan speakers. On real data the developer copies the frozen rule into config.py
(SV_FROZEN_RULE) before the test speakers are scored once.
"""

import json

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, visits_io

OUT = config.SV_DATASET_RESULTS


def require_open_calibration():
    """Once the test speakers are scored, the rule they were scored with must never change."""
    if config.SV_DATASET not in config.SV_DEV_DATASETS and config.SV_TEST_MARKER.exists():
        raise SystemExit(f"The test set was already scored ({config.SV_TEST_MARKER.read_text(encoding='utf-8')}); "
                         "calibration is frozen.")


def main():
    require_open_calibration()
    development = config.SV_DATASET in config.SV_DEV_DATASETS
    plan = pd.read_csv(config.SV_DATASET_DIR / "visits.csv")
    visits = visits_io.load("calibration", "primary", plan)
    rule = decide.calibrate(visits)
    (OUT / "04_calibration.json").write_text(json.dumps(rule, indent=2), encoding="utf-8")

    scores = pd.read_csv(config.SV_DATASET_DIR / "trial_scores.csv")
    scores = scores[(scores["split"] == "calibration") & (scores["test_seconds"] == config.SV_TRIAL_REPORT_SECONDS)]
    eer, threshold = metrics.equal_error_rate(scores["label"], scores["e1"])
    per_scenario = pd.Series([visit["scenario"] for visit in visits]).value_counts()
    false_accept = ", ".join(f"{name} {rule['false_accept'][name]:.3f} (n={per_scenario[name]})"
                             for name in decide.FRAUD_SCENARIOS)
    name, noise, snr, clip_speech, enrol_seconds = config.SV_PRIMARY_CONDITION
    status = ("**Development data only. Not carried over, and judges no target.**" if development else
              "**Calibration speakers only. Frozen: copy the rule into `config.SV_FROZEN_RULE` before the test speakers are scored.**")
    lines = [f"# SV4 calibration: {config.SV_DATASET}", "", status, "",
             f"Visits: the {name} setting, {clip_speech:g} s of speech per recording, {noise} noise at {snr:g} dB, "
             f"{enrol_seconds:g} s enrolment.",
             f"Calibration speakers, E1, clean {config.SV_TRIAL_REPORT_SECONDS:g}-second trial EER: {eer:.4f} at cosine {threshold:.3f}.", "",
             f"Visit rule chosen: both recordings match at cosine {rule['threshold']} or above, and each holds at "
             f"least {rule['min_clip_speech_seconds']:g} s of speech.",
             f"False reject on genuine calibration visits: {rule['false_reject']:.3f} (n={per_scenario[decide.GENUINE]}), "
             f"against the proposed target of {config.SV_TARGET_FALSE_REJECT:.0%}.",
             f"False accept on calibration visits: {false_accept}.",
             f"Worst-scenario false accept at or below the target of {config.SV_TARGET_FALSE_ACCEPT:.0%}: {rule['met_target']}.",
             "These are calibration rates, chosen on these same visits, so they are optimistic. "
             "Only the one-time test score judges the targets.", ""]
    (OUT / "04_calibration.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
