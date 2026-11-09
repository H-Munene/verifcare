"""SV4: choose the visit rule on calibration speakers only. Development data only.

The rule is written to the results folder and deliberately NOT to config.py: it must be recalibrated
on Kenyan calibration speakers before it could mean anything.
"""

import json

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, visits_io

OUT = config.SV_DEV_RESULTS


def main():
    plan = pd.read_csv(config.SV_DATA_DIR / "librispeech_visits.csv")
    rule = decide.calibrate(visits_io.load("calibration", "primary", plan))
    (OUT / "04_calibration.json").write_text(json.dumps(rule, indent=2), encoding="utf-8")

    scores = pd.read_csv(config.SV_DATA_DIR / "trial_scores.csv")
    scores = scores[(scores["split"] == "calibration") & (scores["test_seconds"] == config.SV_VISIT_SECONDS)]
    eer, threshold = metrics.equal_error_rate(scores["label"], scores["e1"])
    lines = ["# SV4 calibration: LibriSpeech", "", "**Development data only. Not carried over, and judges no target.**", "",
             f"Calibration speakers, E1, clean 30-second trial EER: {eer:.4f} at cosine {threshold:.3f}.", "",
             f"Visit rule chosen: threshold {rule['threshold']}, caregiver at least {rule['caregiver_seconds']} s, "
             f"dependant at least {rule['dependant_seconds']} s.",
             f"False reject on calibration visits: {rule['false_reject']:.4f}.",
             f"False accept on calibration visits: {json.dumps(rule['false_accept'])}.",
             f"Worst-scenario false accept at or below the proposed {config.SV_TARGET_FALSE_ACCEPT:.0%}: {rule['met_target']}.", ""]
    (OUT / "04_calibration.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
