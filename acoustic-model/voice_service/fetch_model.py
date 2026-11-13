"""Image build step: download the pinned ECAPA-TDNN into the image, so the Lambda never fetches it."""

import sys

from huggingface_hub import snapshot_download

from mzazi_acoustic.common import config

snapshot_download(repo_id=config.SV_MODEL_NAME, revision=config.SV_MODEL_REVISION, local_dir=sys.argv[1])
