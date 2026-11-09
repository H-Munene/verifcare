"""Read back the cached window scores written by scripts/sv_03_embed.py."""

import numpy as np

from mzazi_acoustic.common import config


def load(split, condition, plan):
    """The plan's visits for one split and condition, each with its window scores."""
    stored = np.load(config.SV_DATA_DIR / "visit_scores" / f"{split}_{condition}.npz")
    edges = np.cumsum(stored["lengths"])[:-1]
    caregiver, dependant = np.split(stored["caregiver"], edges), np.split(stored["dependant"], edges)
    rows = plan[plan["split"] == split]
    return [{"pair": row.pair, "scenario": row.scenario, "caregiver_scores": c, "dependant_scores": d}
            for row, c, d in zip(rows.itertuples(), caregiver, dependant, strict=True)]
