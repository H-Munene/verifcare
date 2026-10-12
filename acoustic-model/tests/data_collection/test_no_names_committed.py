"""No real name may appear in any committed output (PLAN.md Stage 1 tests).

Uses the local lookup of real names, so it only runs on a machine that has the dataset.
"""

import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.data_collection.subjects import normalise_name

LOOKUP = config.COLLECTION_RESULTS / "subject_id_lookup.local.csv"


@pytest.mark.skipif(not LOOKUP.exists(), reason="needs the local subject lookup (run scripts/01_collect.py)")
def test_committed_results_contain_no_real_names():
    import pandas as pd

    folders = pd.read_csv(LOOKUP)["person_folders"].str.split(";").explode()
    names = {f.lower() for f in folders}
    # Normalised forms too, but only long ones: short ones ("bbking") could match unrelated text by chance.
    names |= {normalise_name(f) for f in folders if len(normalise_name(f)) >= 8}

    committed = [p for p in config.RESULTS_DIR.rglob("*") if p.is_file() and not p.name.endswith(".local.csv")]
    assert committed, "no committed results found to check"
    for path in committed:
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
        leaked = sorted(n for n in names if n in text)
        assert not leaked, f"{path.name} contains real names: {leaked[:5]}"
