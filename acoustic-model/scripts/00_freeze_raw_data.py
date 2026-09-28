"""Stage 0: record the size and SHA-256 of every raw file, once. Later stages re-check against it."""

from mzazi_acoustic.common import config, raw_data

table = raw_data.freeze()
print(f"Froze {len(table)} files, {table['size_bytes'].sum() / 1e9:.2f} GB -> {config.RAW_FREEZE_FILE}")
