"""Working out which recordings belong to the same person, and giving each person an anonymous ID.

Rules (PLAN.md Stage 1 step 4):
- Names are normalised (case, spacing, punctuation, accents); identical normalised names are the
  same person.
- Names that are merely similar are flagged for manual review and never merged automatically.
- The subject ID is a keyed hash of the normalised name, so re-running gives the same IDs. The key
  (salt) is local and git-ignored: without it, a plain hash of a public figure's name could be
  reversed by hashing a list of candidate names.
"""

import difflib
import hashlib
import hmac
import itertools
import re
import secrets
import unicodedata

from mzazi_acoustic.common import config


def normalise_name(name):
    """'Jesse  Jackson', 'jessejackson' and 'Jessé-Jackson' all become 'jessejackson'."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_name.lower())


def load_or_create_salt(salt_file=config.SUBJECT_ID_SALT_FILE):
    if not salt_file.exists():
        salt_file.write_text(secrets.token_hex(32))
    return salt_file.read_text().strip()


def make_subject_id(normalised_name, salt):
    digest = hmac.new(salt.encode(), normalised_name.encode(), hashlib.sha256).hexdigest()
    return f"S{digest[:8]}"


def near_duplicate_pairs(normalised_names, threshold=config.NEAR_DUPLICATE_NAME_RATIO):
    """Pairs of distinct normalised names similar enough to need a human look, with their ratio."""
    names = sorted(set(normalised_names))
    pairs = []
    for a, b in itertools.combinations(names, 2):
        ratio = difflib.SequenceMatcher(None, a, b).ratio()
        if ratio >= threshold:
            pairs.append((a, b, round(ratio, 3)))
    return pairs


def name_in_filename(filename):
    """The person-name part of a file name like 'AbeBurrows_5.wav' or 'aileenhernandez_5_1.wav'."""
    stem = filename.rsplit(".", 1)[0]
    return normalise_name(re.split(r"[_\d]", stem, maxsplit=1)[0])
