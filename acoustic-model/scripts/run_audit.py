#!/usr/bin/env python
"""CLI entrypoint for the dataset audit. See acoustic_model.audit for the implementation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from acoustic_model import audit

if __name__ == "__main__":
    audit.run()
    print("Audit complete. See results/audit/audit_summary.md")
