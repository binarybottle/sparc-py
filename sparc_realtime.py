"""
Real-time SPARC articulatory inversion engine.

Runs the full Python SPARC pipeline: WavLM-large (layer 9) -> Butterworth
low-pass filter (10 Hz) -> linear projection -> 12-dim EMA z-scores.

Adapted from Speech-Articulatory-Coding/sparc/inversion.py for streaming use:
  - Rolling audio buffer instead of full-file processing
  - Windowed filtfilt for near-zero-phase filtering in real-time
  - Returns only new frames to avoid redundant data
  - Auto-selects MPS / CUDA / CPU device
"""

import pickle
import time
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
from huggingface_hub import hf_hub_download
from scipy.signal import butter, filtfilt
from transformers import WavLMModel

# EMA channel ordering from the SPARC linear model (12 channels, 6 articulators x 2 coords)
EMA_CHANNELS = [
    "td_x", "td_y", "tb_x", "tb_y", "tt_x", "tt_y",
    "li_x", "li_y", "ul_x", "ul_y", "ll_x", "ll_y",
]

ARTICULATORS = ["td", "tb", "tt", "li", "ul", "ll"]

TARGET_SR = 16000
FT_SR = 50            # WavLM feature rate: 16000 / 320 = 50 Hz
FREQCUT = 10          # Butterworth low-pass cutoff (Hz)
BUTTER_ORDER = 5
TARGET_LAYER = 9
ZERO_PAD_SAMPLES = 160  # 10 ms zero-pad on each side (matches original config)

# Rolling buffer: keep this many seconds of audio for context
BUFFER_SECONDS = 2.0
BUFFER_SAMPLES = int(TARGET_SR * BUFFER_SECONDS)

# Minimum frames for filtfilt to work (2 * max(len(a), len(b)) - 1 padlen)
MIN_FRAMES_FOR_FILTER = 15


def select_device() -> str:
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _download_linear_model() -> str:
    return hf_hub_download(
        repo_id="cheoljun95/Speech-Articulatory-Coding",
        filename="wavlm_large-9_cut-10_mngu_linear.pkl",
    )


class RealtimeSPARC:
    """Streaming articulatory inversion using the SPARC pipeline."""

    def __init__(self, device: Optional[str] = None):
        self.device = device or select_device()
        print(f"[SPARC] Using device: {self.device}")

        t0 = time.time()
        self._load_speech_model()
        self._load_linear_model()
        self._build_filter()
        print(f"[SPARC] Models loaded in {time.time() - t0:.1f}s")

        self.audio_buffer = np.zeros(BUFFER_SAMPLES, dtype=np.float32)
        self.buffer_pos = 0  # how many samples have been written total
        self._prev_n_frames = 0  # hidden-state frames from the previous inference

    def _load_speech_model(self):
        print("[SPARC] Loading WavLM-large (truncated to layer 9)...")
        self.speech_model = WavLMModel.from_pretrained("microsoft/wavlm-large")
        self.speech_model.encoder.layers = self.speech_model.encoder.layers[:TARGET_LAYER + 1]
        self.speech_model = self.speech_model.eval().to(self.device)
        for p in self.speech_model.parameters():
            p.requires_grad_(False)

    def _load_linear_model(self):
        print("[SPARC] Loading linear EMA projection...")
        pkl_path = _download_linear_model()
        with open(pkl_path, "rb") as f:
            sklearn_model = pickle.load(f)
        state_dict = {
            "weight": torch.tensor(sklearn_model.coef_, dtype=torch.float32),
            "bias": torch.tensor(sklearn_model.intercept_, dtype=torch.float32),
        }
        out_dim, in_dim = state_dict["weight"].shape
        self.linear_model = nn.Linear(in_dim, out_dim)
        self.linear_model.load_state_dict(state_dict)
        self.linear_model.requires_grad_(False)
        self.linear_model = self.linear_model.eval().to(self.device)

    def _build_filter(self):
        self.butter_b, self.butter_a = butter(BUTTER_ORDER, FREQCUT, fs=FT_SR, btype="low")

    def reset(self):
        """Clear the rolling buffer for a new recording session."""
        self.audio_buffer[:] = 0
        self.buffer_pos = 0
        self._prev_n_frames = 0

    def feed_audio(self, pcm: np.ndarray) -> Optional[dict]:
        """
        Append new PCM audio (float32, 16 kHz, mono) and run inference.

        Returns a dict with 'ema' (list of new-frame dicts), 'loudness' (float),
        and 'n_new_frames' (int), or None if not enough data yet.
        """
        pcm = np.asarray(pcm, dtype=np.float32).ravel()
        n_new = len(pcm)

        # Write into the circular buffer
        buf_len = len(self.audio_buffer)
        start = self.buffer_pos % buf_len
        if start + n_new <= buf_len:
            self.audio_buffer[start:start + n_new] = pcm
        else:
            first = buf_len - start
            self.audio_buffer[start:] = pcm[:first]
            self.audio_buffer[:n_new - first] = pcm[first:]
        self.buffer_pos += n_new

        # Need at least ~0.5s of audio before first inference
        total_samples = min(self.buffer_pos, buf_len)
        if total_samples < TARGET_SR // 2:
            return None

        # Extract the valid portion of the buffer (unwrap circular)
        if self.buffer_pos <= buf_len:
            audio = self.audio_buffer[:self.buffer_pos].copy()
        else:
            pos = self.buffer_pos % buf_len
            audio = np.concatenate([self.audio_buffer[pos:], self.audio_buffer[:pos]])

        # z-score normalize (per the original SPARC pipeline)
        std = audio.std()
        if std > 1e-6:
            audio = (audio - audio.mean()) / std

        # RMS loudness of the new chunk
        rms = float(np.sqrt(np.mean(pcm ** 2)))
        loudness_db = 20 * np.log10(max(rms, 1e-10))

        # Run WavLM inference
        ema_all = self._infer(audio)  # shape (n_frames, 12)

        # Determine how many frames are new
        n_total_frames = ema_all.shape[0]
        n_new_frames = max(1, n_total_frames - self._prev_n_frames)
        self._prev_n_frames = n_total_frames

        # Return the new frames as a list of articulator dicts
        new_ema = ema_all[-n_new_frames:]

        frames = []
        for row in new_ema:
            frame = {}
            for i, ch in enumerate(EMA_CHANNELS):
                frame[ch] = float(row[i])
            frames.append(frame)

        return {
            "ema": frames,
            "loudness": loudness_db,
            "n_new_frames": n_new_frames,
        }

    def _infer(self, audio: np.ndarray) -> np.ndarray:
        """Run WavLM + Butterworth + linear projection on normalized audio."""
        wav_tensor = torch.from_numpy(audio).float().unsqueeze(0).to(self.device)

        # Zero-pad (matches original config: zero_pad=True, 160 samples each side)
        pad = torch.zeros(1, ZERO_PAD_SAMPLES, dtype=wav_tensor.dtype, device=wav_tensor.device)
        wav_tensor = torch.cat([pad, wav_tensor, pad], dim=1)

        attention_mask = torch.ones_like(wav_tensor)

        with torch.no_grad():
            outputs = self.speech_model(
                wav_tensor,
                attention_mask=attention_mask,
                output_hidden_states=True,
            )

        # Extract target layer hidden states -> (1, T, 1024)
        states = outputs.hidden_states[TARGET_LAYER].cpu().numpy()

        # Butterworth low-pass filter along time axis
        if states.shape[1] >= MIN_FRAMES_FOR_FILTER:
            states = filtfilt(self.butter_b, self.butter_a, states, axis=1)

        # Linear projection -> EMA z-scores
        state_shape = states.shape  # (1, T, 1024)
        flat = np.ascontiguousarray(states.reshape(-1, state_shape[-1]))

        with torch.no_grad():
            ema = self.linear_model(
                torch.tensor(flat, dtype=torch.float32).to(self.device)
            )
        ema = ema.detach().cpu().numpy()
        ema = ema.reshape(state_shape[0], state_shape[1], 12)

        return ema[0]  # (T, 12)
