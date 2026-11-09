"""v3 embeddings (PLAN.md v3.2-v3.3, v3.7): windowing, pooling, determinism, layer selection inside
the pipeline, and the extraction script never reading a test-split clip. A tiny random-weight
encoder stands in for XLS-R, so these run without the 1.2 GB download."""

import runpy
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from sklearn.base import clone

from mzazi_acoustic.common import config, guards
from mzazi_acoustic.embeddings import xlsr
from mzazi_acoustic.model_training import candidates, cv

SR = 16_000
SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


@pytest.mark.parametrize("seconds, expected", [
    (45, [(0, 20), (20, 40), (40, 45)]),  # a 5 s remainder is kept
    (43, [(0, 20), (20, 43)]),  # a 3 s remainder joins the previous window
    (10, [(0, 10)]),  # shorter than one window: one window
    (0, []),
])
def test_windows(seconds, expected):
    assert xlsr.windows(seconds * SR, SR) == [(a * SR, b * SR) for a, b in expected]


@pytest.fixture(scope="module")
def tiny_encoder():
    torch = pytest.importorskip("torch")
    transformers = pytest.importorskip("transformers")
    torch.manual_seed(0)
    model_config = transformers.Wav2Vec2Config(
        hidden_size=16, num_hidden_layers=3, num_attention_heads=2, intermediate_size=32,
        conv_dim=(8, 8), conv_stride=(5, 4), conv_kernel=(10, 8), num_conv_pos_embeddings=16,
        num_conv_pos_embedding_groups=2, do_stable_layer_norm=True, feat_extract_norm="layer")
    model = transformers.Wav2Vec2Model(model_config).eval()
    extractor = transformers.Wav2Vec2FeatureExtractor(sampling_rate=SR, do_normalize=True)
    return model, extractor


def test_embed_shape_determinism_and_length_weighting(tiny_encoder):
    model, extractor = tiny_encoder
    rng = np.random.default_rng(1)
    y = rng.standard_normal(45 * SR).astype(np.float32) * 0.1
    first, second = xlsr.embed(y, SR, model, extractor), xlsr.embed(y, SR, model, extractor)
    assert first.shape == (4, 16) and first.dtype == np.float32  # CNN projection + 3 layers
    np.testing.assert_allclose(first, second, atol=1e-5)
    # Window-length weighting: the 45 s clip equals the weighted mean of its three windows.
    parts = [xlsr.embed(y[a:b], SR, model, extractor) for a, b in xlsr.windows(len(y), SR)]
    np.testing.assert_allclose(first, np.average(parts, axis=0, weights=[20, 20, 5]), atol=1e-5)
    assert xlsr.embed(np.zeros(0, np.float32), SR, model, extractor) is None
    with pytest.raises(ValueError):
        xlsr.embed(y, 8_000, model, extractor)


def test_pause_audio_keeps_only_the_pauses():
    t = np.arange(int(12 * SR)) / SR
    tone = 0.3 * np.sin(2 * np.pi * 150 * t)
    y = tone * ((t < 5) | (t >= 7))  # speech, a 2 s pause, speech
    audio, seconds = xlsr.pause_audio(y.astype(np.float32), SR)
    assert seconds == pytest.approx(2.0, abs=0.1)
    assert np.abs(audio).max() < 0.01


def test_layer_select_takes_one_block_and_rejects_other_layers():
    layers = (6, 9)
    X = np.hstack([np.zeros((3, 4)), np.ones((3, 4))])
    assert (xlsr.LayerSelect(9, layers, 4).fit(X).transform(X) == 1).all()
    assert clone(xlsr.LayerSelect(9, layers, 4)).layer == 9
    with pytest.raises(ValueError):
        xlsr.LayerSelect(12, layers, 4).fit(X)


def test_layer_and_pca_are_tuned_inside_the_search():
    space = candidates.search_space(config.V3_MODEL)
    assert set(space) == {"select__layer", "pca__n_components", "model__C"}
    with candidates.routing():
        pipeline = candidates.make_pipeline(config.V3_MODEL, 0)
    assert [name for name, _ in pipeline.steps] == ["impute", "select", "scale", "pca", "model"]


def test_v3_pipeline_finds_the_layer_that_carries_the_signal(monkeypatch):
    """End to end on synthetic embeddings: only layer 15's block separates the classes."""
    monkeypatch.setattr(candidates, "SEARCH_N_JOBS", 1)
    rng = np.random.default_rng(0)
    n_people, columns = 120, xlsr.layer_columns()  # inner folds above the largest PCA size, as in real runs
    labels = np.repeat([0, 1], n_people // 2)
    X = rng.standard_normal((n_people, len(columns)))
    block = config.EMBEDDING_CANDIDATE_LAYERS.index(15) * 1024
    X[:, block:block + 1024] += labels[:, None] * 0.6
    table = pd.DataFrame(X, columns=columns).assign(file_id=[f"f{i}" for i in range(n_people)],
                                                    subject_id=[f"s{i}" for i in range(n_people)], label=labels)
    model, log = cv.fit_calibrated(config.V3_MODEL, "tuned", table[columns], table["label"], table["subject_id"], 0)
    assert len(log) == config.SEARCH_CONFIGS_PER_MODEL
    assert model.pipeline.named_steps["select"].layer == 15


def test_load_table_flattens_candidate_layers_and_leaves_missing_clips_nan(tmp_path):
    rows = pd.DataFrame({"file_id": ["a", "b"]})
    array = np.arange(25 * 1024, dtype=np.float32).reshape(25, 1024)
    np.save(tmp_path / "a.npy", array)
    table = xlsr.load_table(rows, "clean", cache=lambda variant, file_id: tmp_path / f"{file_id}.npy")
    first = table.loc[0, xlsr.layer_columns()].to_numpy(float)
    assert first[0] == array[6, 0] and first[-1] == array[18, -1]
    assert table.loc[1, xlsr.layer_columns()].isna().all()


def test_extraction_never_reads_a_test_split_clip(monkeypatch, tmp_path):
    splits = pd.DataFrame({
        "file_id": ["tr1", "te1", "tj1", "tj2"], "subject_id": ["s1", "s2", "s3", "s2"], "label": [0, 1, 1, 1],
        "split": ["train", "test", "train", "test"],
        "role": ["training_pool", "training_pool", "trajectory", "trajectory"]})
    path = tmp_path / "splits.csv"
    splits.to_csv(path, index=False)
    monkeypatch.setattr(guards, "SPLITS_FILE", path)
    clips = runpy.run_path(str(SCRIPTS / "03v3_embeddings.py"))["clips"]()
    assert sorted(clips["file_id"]) == ["tj1", "tr1"]


def test_full_extraction_refuses_an_unpinned_encoder(monkeypatch):
    monkeypatch.setattr(config, "ENCODER_REVISION", None)
    monkeypatch.setattr("sys.argv", ["03v3_embeddings.py"])
    with pytest.raises(SystemExit, match="Pin config.ENCODER_REVISION"):
        runpy.run_path(str(SCRIPTS / "03v3_embeddings.py"), run_name="__main__")
