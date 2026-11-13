"""Voice activity detection: which samples of a recording are speech."""

import numpy as np

from mzazi_acoustic.common import config


class Vad:
    def __init__(self):
        from silero_vad import load_silero_vad

        self.model = load_silero_vad()

    def speech_mask(self, y):
        """A boolean per sample, true where Silero hears speech. Settings are fixed in config."""
        import torch
        from silero_vad import get_speech_timestamps

        regions = get_speech_timestamps(torch.from_numpy(np.asarray(y, dtype=np.float32)), self.model,
                                        threshold=config.SV_VAD_THRESHOLD, sampling_rate=config.SV_SAMPLE_RATE)
        mask = np.zeros(len(y), dtype=bool)
        for region in regions:
            mask[region["start"]:region["end"]] = True
        return mask
