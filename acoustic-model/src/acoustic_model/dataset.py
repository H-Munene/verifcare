"""Single source of truth for walking the raw DementiaNet folders and
assigning anonymized, stable identities (subject_id, file_id) to every
subject and file.

Every phase that needs to locate a real file on disk or needs a
file_id/subject_id consistent with a previous phase's output must go
through `build_file_index()` here, not re-implement discovery. Doing
discovery in two places was a real bug (see acoustic-model-dev-log.md,
Phase 2): file_id previously reset its per-file counter for every raw
folder independently, so the 16 subjects with both a `nodementia/` and
a `nodementia2/` folder got colliding file_ids across the two folders.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from acoustic_model.config import CLASS_LABEL_MAP, DATA_ROOT, RAW_CLASS_DIRS
from acoustic_model.subject_names import assign_subject_ids, canonicalize, dedup_key

# Matches the "_<marker>" or "_<marker>_<sub_index>" suffix on a wav
# filename stem, e.g. "AbeBurrows_5" -> marker=5, or
# "aileenhernandez_5_1" -> marker=5, sub_index=1.
_SUFFIX_PATTERN = re.compile(r"_(\d+)(?:_(\d+))?$")

# The two folders use unrelated numbering schemes (see README.md):
# dementia's marker approximates years-relative-to-symptom-onset;
# nodementia/nodementia2's marker is a 1/2/3 index into the
# 5/10/15-years-before-death-or-current-age scheme.
YEARS_PRE_SYMPTOM_SCHEME = "years_pre_symptom_marker"
DEATH_OR_CURRENT_AGE_INDEX_SCHEME = "death_or_current_age_index"


def _parse_suffix(stem: str) -> tuple[int | None, int | None]:
    match = _SUFFIX_PATTERN.search(stem)
    if not match:
        return None, None
    marker = int(match.group(1))
    sub_index = int(match.group(2)) if match.group(2) else None
    return marker, sub_index


def _numbering_scheme(raw_class_dir: str) -> str:
    return YEARS_PRE_SYMPTOM_SCHEME if raw_class_dir == "dementia" else DEATH_OR_CURRENT_AGE_INDEX_SCHEME


@dataclass(frozen=True)
class RawSubjectFolder:
    raw_class_dir: str
    path: Path


def discover_raw_subject_folders(
    data_root: Path = DATA_ROOT, raw_class_dirs: tuple[str, ...] = RAW_CLASS_DIRS
) -> list[RawSubjectFolder]:
    folders: list[RawSubjectFolder] = []
    for raw_class_dir in raw_class_dirs:
        class_path = data_root / raw_class_dir
        if not class_path.is_dir():
            raise FileNotFoundError(f"Expected raw class directory not found: {class_path}")
        for subject_path in sorted(p for p in class_path.iterdir() if p.is_dir()):
            folders.append(RawSubjectFolder(raw_class_dir=raw_class_dir, path=subject_path))
    return folders


def _wav_files(subject_dir: Path) -> list[Path]:
    return sorted({p for p in subject_dir.iterdir() if p.suffix.lower() == ".wav"})


@dataclass(frozen=True)
class FileEntry:
    file_id: str
    subject_id: str
    class_label: str
    canonical_name: str
    raw_class_dir: str
    raw_subject_folder: str
    numbering_scheme: str
    suffix_marker: int | None
    suffix_sub_index: int | None
    path: Path


def build_file_index(
    data_root: Path = DATA_ROOT,
    raw_class_dirs: tuple[str, ...] = RAW_CLASS_DIRS,
    class_label_map: dict[str, str] = CLASS_LABEL_MAP,
) -> list[FileEntry]:
    """Deterministically enumerate every raw wav file with its anonymized identity.

    file_id is assigned per subject_id across *all* of that subject's raw folders
    combined (not per raw folder), so a subject spanning both nodementia/ and
    nodementia2/ still gets a single, collision-free sequence of file_ids. Files are
    ordered by (raw_class_dir, raw_subject_folder, filename) for determinism, so
    re-running this against an unchanged dataset always reproduces the same ids.
    """
    raw_folders = discover_raw_subject_folders(data_root, raw_class_dirs)
    canonical_names = [canonicalize(folder.path.name) for folder in raw_folders]
    identities_by_key = assign_subject_ids(canonical_names)

    # (subject_id) -> list of (raw_class_dir, raw_subject_folder, wav_path, class_label)
    files_by_subject: dict[str, list[tuple[str, str, Path, str]]] = {}
    for folder in raw_folders:
        canonical_name = canonicalize(folder.path.name)
        identity = identities_by_key[dedup_key(canonical_name)]
        class_label = class_label_map[folder.raw_class_dir]
        for wav_path in _wav_files(folder.path):
            files_by_subject.setdefault(identity.subject_id, []).append(
                (folder.raw_class_dir, folder.path.name, wav_path, class_label)
            )

    entries: list[FileEntry] = []
    for subject_id in sorted(files_by_subject):
        canonical_name = next(
            identity.canonical_name
            for identity in identities_by_key.values()
            if identity.subject_id == subject_id
        )
        ordered_files = sorted(files_by_subject[subject_id], key=lambda item: (item[0], item[1], item[2].name))
        for file_index, (raw_class_dir, raw_subject_folder, wav_path, class_label) in enumerate(
            ordered_files, start=1
        ):
            marker, sub_index = _parse_suffix(wav_path.stem)
            entries.append(
                FileEntry(
                    file_id=f"{subject_id}_f{file_index:02d}",
                    subject_id=subject_id,
                    class_label=class_label,
                    canonical_name=canonical_name,
                    raw_class_dir=raw_class_dir,
                    raw_subject_folder=raw_subject_folder,
                    numbering_scheme=_numbering_scheme(raw_class_dir),
                    suffix_marker=marker,
                    suffix_sub_index=sub_index,
                    path=wav_path,
                )
            )
    return entries
