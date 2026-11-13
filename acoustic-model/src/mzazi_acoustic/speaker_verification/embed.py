"""Voiceprints from waveforms: frozen ECAPA-TDNN (E1) and the weak MFCC baseline (B0)."""

import numpy as np

from mzazi_acoustic.common import config


def normalise(vectors):
    """Unit length, so a dot product is a cosine similarity."""
    vectors = np.asarray(vectors, dtype=np.float32)
    return vectors / np.clip(np.linalg.norm(vectors, axis=-1, keepdims=True), 1e-12, None)


class Embedder:
    """Frozen, pinned ECAPA-TDNN on the CPU. Nothing here trains."""

    def __init__(self, local_dir=None):
        """local_dir: a folder already holding the pinned model (the voice Lambda's image), so
        nothing is fetched. Otherwise the pinned revision is downloaded once into the data folder."""
        import torch
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import FetchConfig, LocalStrategy

        torch.set_num_threads(config.SV_TORCH_THREADS)
        self._torch = torch
        if local_dir is not None:
            # hyperparams.yaml loads its weights from pretrained_path, which names the Hub.
            self.model = EncoderClassifier.from_hparams(
                source=str(local_dir), savedir=str(local_dir), run_opts={"device": "cpu"},
                overrides={"pretrained_path": str(local_dir)}, local_strategy=LocalStrategy.NO_LINK)
        else:
            # COPY, because the default symlinks need developer mode on Windows.
            self.model = EncoderClassifier.from_hparams(
                source=config.SV_MODEL_NAME, fetch_config=FetchConfig(revision=config.SV_MODEL_REVISION),
                savedir=str(config.SV_DATA_DIR / "ecapa"), run_opts={"device": "cpu"},
                local_strategy=LocalStrategy.COPY)
        self.model.eval()

    def embed_batch(self, batch):
        """Equal-length waveforms, shape (n, samples), to unit voiceprints, shape (n, dim)."""
        batch = np.asarray(batch, dtype=np.float32)
        if len(batch) == 0:
            return np.empty((0, 192), dtype=np.float32)
        with self._torch.no_grad():
            embeddings = self.model.encode_batch(self._torch.from_numpy(batch))
        return normalise(embeddings.squeeze(1).cpu().numpy())

    def embed(self, y):
        return self.embed_batch(np.asarray(y, dtype=np.float32)[None])[0]


def mfcc_statistics(y):
    """B0: mean and standard deviation of 20 MFCCs, as a unit vector."""
    import librosa

    mfcc = librosa.feature.mfcc(y=np.asarray(y, dtype=np.float32), sr=config.SV_SAMPLE_RATE, n_mfcc=20)
    return normalise(np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)]))
