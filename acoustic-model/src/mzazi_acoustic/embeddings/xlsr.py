"""v3 single-recording embedding (PLAN.md v3.2): one waveform in, one (layers, dim) array out.

The encoder is frozen and only ever run forward. Training builds the embedding table by calling
embed() on every clip, and a deployed service would call it on each upload, so both see the same
windowing and pooling. torch and transformers are imported lazily, so the rest of the package
(and its tests) doesn't need them.
"""

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering import pause_detector


def windows(n_samples, sr, window_s=config.EMBEDDING_WINDOW_SECONDS,
            min_last_s=config.EMBEDDING_MIN_LAST_WINDOW_SECONDS):
    """(start, end) sample ranges: consecutive, non-overlapping windows of window_s. A remainder
    shorter than min_last_s joins the previous window; a clip shorter than one window is one window."""
    size, min_last = int(round(window_s * sr)), int(round(min_last_s * sr))
    spans = [[start, min(start + size, n_samples)] for start in range(0, n_samples, size)]
    if len(spans) > 1 and spans[-1][1] - spans[-1][0] < min_last:
        remainder = spans.pop()
        spans[-1][1] = remainder[1]
    return [tuple(span) for span in spans]


def load_encoder(name=config.ENCODER_NAME, revision=config.ENCODER_REVISION):
    """(model, feature extractor), in eval mode with a fixed thread count (PLAN.md v3.2 step 5)."""
    import torch
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2Model

    torch.manual_seed(config.SEED)
    torch.set_num_threads(config.EMBEDDING_TORCH_THREADS)
    extractor = Wav2Vec2FeatureExtractor.from_pretrained(name, revision=revision)
    model = Wav2Vec2Model.from_pretrained(name, revision=revision).eval()
    return model, extractor


def embed(y, sr, model, extractor):
    """Every hidden state (CNN projection + each transformer layer), mean-pooled over time within
    each window, then averaged over windows weighted by window length. Returns float32
    (n_layers + 1, hidden_size), or None for empty input."""
    import torch

    if sr != extractor.sampling_rate:
        raise ValueError(f"expected {extractor.sampling_rate} Hz audio, got {sr}")
    spans = windows(len(y), sr)
    if not spans:
        return None
    pooled = []
    with torch.inference_mode():
        for start, end in spans:
            # The extractor normalises each window to zero mean, unit variance, as XLS-R expects.
            inputs = extractor(np.asarray(y[start:end], np.float32), sampling_rate=sr, return_tensors="pt")
            hidden = model(inputs.input_values, output_hidden_states=True).hidden_states
            pooled.append(torch.stack(hidden)[:, 0].mean(dim=1).numpy())  # (layers, dim)
    lengths = [end - start for start, end in spans]
    return np.average(np.stack(pooled), axis=0, weights=lengths).astype(np.float32)


def pause_audio(y, sr):
    """C3 (PLAN.md v3.4): only the frozen pause detector's internal pauses, concatenated in order.
    Returns (audio, seconds); empty when the clip has no pauses."""
    result = pause_detector.detect_pauses(y, sr)
    pieces = [y[int(round(start * sr)):int(round(end * sr))] for start, end in result.pauses]
    audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    return audio, len(audio) / sr


def layer_columns(layers=config.EMBEDDING_CANDIDATE_LAYERS, dim=1024):
    """Column names of the embedding table: the candidate layers only, in config order."""
    return [f"L{layer}_{i}" for layer in layers for i in range(dim)]


class LayerSelect(BaseEstimator, TransformerMixin):
    """Pipeline step that keeps one layer's block of columns from the candidate-layer table.

    Being a step, the layer is tuned inside the inner search and fitted per fold, never chosen
    on outer-fold results (PLAN.md v3.3)."""

    def __init__(self, layer=12, layers=tuple(config.EMBEDDING_CANDIDATE_LAYERS), dim=1024):
        self.layer, self.layers, self.dim = layer, layers, dim

    def fit(self, X, y=None):
        if self.layer not in self.layers:
            raise ValueError(f"layer {self.layer} is not a candidate layer {self.layers}")
        return self

    def transform(self, X):
        start = list(self.layers).index(self.layer) * self.dim
        return np.asarray(X)[:, start:start + self.dim]


def cache_path(variant, file_id):
    """data/embeddings/<variant>/<file_id>.npy, with '+' and '@' made filename-safe."""
    return config.EMBEDDING_CACHE / variant.replace("+", "_").replace("@", "_") / f"{file_id}.npy"


def load_table(rows, variant, cache=None):
    """rows (file_id, ...) joined with each clip's candidate-layer embedding, flattened into the
    layer_columns() order. A clip with no cached embedding gets NaN (C3 only; imputed in the fold)."""
    cache = cache or cache_path
    columns = layer_columns()
    matrix = np.full((len(rows), len(columns)), np.nan, dtype=np.float32)
    for i, file_id in enumerate(rows["file_id"]):
        path = cache(variant, file_id)
        if path.exists():
            matrix[i] = np.load(path)[config.EMBEDDING_CANDIDATE_LAYERS].ravel()
    return pd.concat([rows.reset_index(drop=True), pd.DataFrame(matrix, columns=columns)], axis=1)
