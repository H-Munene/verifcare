import soundfile as sf
import numpy as np

from acoustic_model.dataset import build_file_index

_SAMPLE_RATE_HZ = 44100


def _write_wav(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tone = 0.1 * np.sin(2 * np.pi * 440 * np.arange(_SAMPLE_RATE_HZ) / _SAMPLE_RATE_HZ)
    sf.write(str(path), np.tile(tone[:, None], (1, 2)), _SAMPLE_RATE_HZ, subtype="PCM_16")


def _build_fake_dataset(root):
    # A dementia-only subject.
    _write_wav(root / "dementia" / "Alice Example" / "AliceExample_0.wav")
    # A subject appearing under both nodementia/ and nodementia2/ - the exact
    # shape that previously caused colliding file_ids (see dataset.py's module
    # docstring and acoustic-model-dev-log.md's Phase 2 entry).
    _write_wav(root / "nodementia" / "Bob Example" / "BobExample_1.wav")
    _write_wav(root / "nodementia" / "Bob Example" / "BobExample_2.wav")
    _write_wav(root / "nodementia2" / "Bob Example" / "BobExample_1.wav")
    _write_wav(root / "nodementia2" / "Bob Example" / "BobExample_2.wav")


def test_file_ids_are_unique_for_a_subject_spanning_two_raw_folders(tmp_path):
    _build_fake_dataset(tmp_path)

    entries = build_file_index(
        data_root=tmp_path,
        raw_class_dirs=("dementia", "nodementia", "nodementia2"),
        class_label_map={"dementia": "dementia", "nodementia": "no_dementia", "nodementia2": "no_dementia"},
    )

    file_ids = [entry.file_id for entry in entries]
    assert len(file_ids) == len(set(file_ids)), f"duplicate file_ids: {file_ids}"

    bob_entries = [e for e in entries if e.canonical_name == "Bob Example"]
    assert len(bob_entries) == 4
    assert {e.file_id for e in bob_entries} == {"subj_002_f01", "subj_002_f02", "subj_002_f03", "subj_002_f04"}
    assert {e.raw_class_dir for e in bob_entries} == {"nodementia", "nodementia2"}


def test_build_file_index_is_deterministic_across_calls(tmp_path):
    _build_fake_dataset(tmp_path)
    kwargs = dict(
        data_root=tmp_path,
        raw_class_dirs=("dementia", "nodementia", "nodementia2"),
        class_label_map={"dementia": "dementia", "nodementia": "no_dementia", "nodementia2": "no_dementia"},
    )

    first = [(e.file_id, e.subject_id) for e in build_file_index(**kwargs)]
    second = [(e.file_id, e.subject_id) for e in build_file_index(**kwargs)]

    assert first == second
