"""Subject-name canonicalization and cross-folder deduplication.

Subject folder names on disk are inconsistent (typos, stray casing,
an apostrophe-to-underscore sanitization artifact) and the same person
can appear under both nodementia/ and nodementia2/. This module turns
a raw folder name into a stable canonical identity so no person ends
up counted twice, or split across two different subject_ids, once
nodementia and nodementia2 are merged into one negative class.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

# Known typos/artifacts identified by manual review of the raw folder
# names during dataset exploration, keyed by the exact raw folder name
# as it appears on disk. Corrected explicitly rather than guessed, so
# a reviewer can see and audit every change made.
KNOWN_CORRECTIONS: dict[str, str] = {
    "Harrion ford": "Harrison Ford",
    "Sidney Poiter": "Sidney Poitier",
    "David Attenboroug": "David Attenborough",
    "Morgen Freeman": "Morgan Freeman",
    "Jessejackson": "Jesse Jackson",
    "Chuck norris": "Chuck Norris",
    "Mel brooks": "Mel Brooks",
    "Ross Mac Donald": "Ross Macdonald",
    "Ronan O_Rahilly": "Ronan O'Rahilly",
}


def _normalize_whitespace(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip())


def canonicalize(raw_name: str) -> str:
    """Return the corrected, whitespace-normalized display name for a raw folder name."""
    normalized = _normalize_whitespace(raw_name)
    return KNOWN_CORRECTIONS.get(normalized, normalized)


def dedup_key(canonical_name: str) -> str:
    """Case-insensitive key used to match the same person across folders."""
    return canonical_name.casefold()


@dataclass(frozen=True)
class SubjectIdentity:
    subject_id: str
    canonical_name: str
    dedup_key: str


def assign_subject_ids(canonical_names: list[str]) -> dict[str, SubjectIdentity]:
    """Assign a stable subject_id per unique person.

    Grouping is by case-insensitive dedup_key, so the same person found
    under different casing (or under both nodementia/ and
    nodementia2/) collapses to one subject_id. IDs are assigned in
    sorted-dedup-key order so they stay stable across re-runs as long
    as the underlying set of subjects doesn't change.

    Returns a mapping from dedup_key -> SubjectIdentity.
    """
    unique_keys = sorted({dedup_key(name) for name in canonical_names})

    representative_by_key: dict[str, str] = {}
    for name in sorted(canonical_names):
        key = dedup_key(name)
        representative_by_key.setdefault(key, name)

    identities: dict[str, SubjectIdentity] = {}
    for index, key in enumerate(unique_keys, start=1):
        identities[key] = SubjectIdentity(
            subject_id=f"subj_{index:03d}",
            canonical_name=representative_by_key[key],
            dedup_key=key,
        )
    return identities


def find_unflagged_near_duplicates(
    canonical_names: list[str], cutoff: float = 0.88
) -> list[tuple[str, str, float]]:
    """Flag near-duplicate canonical names not already unified by dedup_key.

    This is a manual-review aid, not an auto-merge: it surfaces pairs of
    distinct canonical names (different dedup_key) that are textually
    very close, in case they're actually the same person under a typo
    or formatting variant KNOWN_CORRECTIONS doesn't cover yet. Returns
    (name_a, name_b, similarity_ratio) tuples, sorted by similarity
    descending. Callers must keep this output local-only: it names real
    people and must never be written to a committed file.
    """
    unique_names = sorted({name for name in canonical_names})
    flagged: list[tuple[str, str, float]] = []
    for i, name_a in enumerate(unique_names):
        candidates = unique_names[i + 1 :]
        if not candidates:
            continue
        matches = difflib.get_close_matches(name_a, candidates, n=len(candidates), cutoff=cutoff)
        for name_b in matches:
            if dedup_key(name_a) == dedup_key(name_b):
                continue  # already unified by exact case-insensitive match
            ratio = difflib.SequenceMatcher(None, name_a, name_b).ratio()
            flagged.append((name_a, name_b, ratio))
    return sorted(flagged, key=lambda item: item[2], reverse=True)
