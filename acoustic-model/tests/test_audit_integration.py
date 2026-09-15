import pandas as pd
import pytest

from acoustic_model import audit
from acoustic_model.config import AUDIT_RESULTS_DIR, DATA_ROOT

pytestmark = pytest.mark.skipif(
    not DATA_ROOT.exists(), reason="raw DementiaNet dataset not present under acoustic-model/data/"
)


def test_run_produces_expected_output_files():
    audit.run()

    file_manifest = pd.read_csv(AUDIT_RESULTS_DIR / "file_manifest.csv")
    subject_manifest = pd.read_csv(AUDIT_RESULTS_DIR / "subject_manifest.csv")
    lookup = pd.read_csv(AUDIT_RESULTS_DIR / "subject_id_lookup.local.csv")
    summary_text = (AUDIT_RESULTS_DIR / "audit_summary.md").read_text(encoding="utf-8")

    assert len(file_manifest) > 0
    assert len(subject_manifest) > 0
    assert set(file_manifest["subject_id"]) <= set(subject_manifest["subject_id"])
    assert len(lookup) == len(subject_manifest)
    assert "Dataset Audit Summary" in summary_text

    # No real name should leak into the committed manifests: every canonical name in
    # the local-only lookup must be absent from the committed file/subject manifests.
    file_manifest_text = file_manifest.to_csv(index=False)
    subject_manifest_text = subject_manifest.to_csv(index=False)
    for name in lookup["canonical_name"]:
        assert name not in file_manifest_text
        assert name not in subject_manifest_text
