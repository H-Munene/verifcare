"""Read back the cached clip scores written by scripts/sv_03_embed.py."""

import numpy as np

from mzazi_acoustic.common import config


def load(split, condition, plan):
    """The plan's visits for one split and condition, each with its two clip scores and speech seconds."""
    stored = np.load(config.SV_DATASET_DIR / "visit_scores" / f"{split}_{condition}.npz")
    rows = plan[plan["split"] == split]
    return [{"pair": row.pair, "scenario": row.scenario, "caregiver_score": float(c), "caregiver_speech": float(cs),
             "dependant_score": float(d), "dependant_speech": float(ds)}
            for row, c, cs, d, ds in zip(rows.itertuples(), stored["caregiver"], stored["caregiver_speech"],
                                         stored["dependant"], stored["dependant_speech"], strict=True)]
