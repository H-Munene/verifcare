"""The test-set guard: training rows only by default, and only the final evaluation may ask for test rows."""

import re
from pathlib import Path

import pandas as pd

from mzazi_acoustic.common import guards

PACKAGE = Path(__file__).resolve().parents[2] / "src" / "mzazi_acoustic"
SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def test_load_rows_returns_training_rows_only_by_default():
    table = pd.DataFrame({"file_id": ["a", "b", "c", "outside_pool"], "x": [1, 2, 3, 4]})
    splits = pd.DataFrame({"file_id": ["a", "b", "c"], "split": ["train", "test", "train"]})
    assert list(guards.load_rows(table, splits)["file_id"]) == ["a", "c"]
    assert set(guards.load_rows(table, splits, include_test=True)["file_id"]) == {"a", "b", "c"}


def test_only_the_final_evaluation_module_passes_include_test_true():
    offenders = []
    for path in [*PACKAGE.rglob("*.py"), *SCRIPTS.glob("*.py")]:
        if path.as_posix().endswith(guards.FINAL_EVALUATION_MODULE) or path.name == "guards.py":
            continue
        if re.search(r"include_test\s*=\s*True", path.read_text(encoding="utf-8")):
            offenders.append(path.name)
    assert not offenders, f"only {guards.FINAL_EVALUATION_MODULE} may load test rows: {offenders}"
