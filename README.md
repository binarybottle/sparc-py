# SPARC Python — Real-Time Articulatory Visualization

Real-time speech articulatory visualization using the full Python SPARC pipeline
(WavLM-large + Butterworth filter + linear EMA projection) with a browser-based
SVG display.

## Architecture

```
Browser (mic)  ──PCM audio──▶  Python server  ──EMA z-scores──▶  Browser (SVG)
                 WebSocket       WavLM layer 9                    WebSocket
                 (binary)        Butterworth 10Hz LP               (JSON)
                                 Linear projection
```

1. The browser captures microphone audio via the Web Audio API.
2. Raw Float32 PCM chunks (~100 ms, 16 kHz) are sent over WebSocket to the
   Python server.
3. The server maintains a rolling 2-second audio buffer, runs WavLM inference
   on the full buffer, applies a 10 Hz Butterworth low-pass filter
   (`scipy.signal.filtfilt`) to the hidden states, and projects through a
   linear model to produce 12-channel EMA z-scores (6 articulators × 2 axes).
4. The latest EMA frame is sent back to the browser as JSON.
5. The browser maps z-scores to SVG display coordinates and renders animated
   articulator markers.

## Quick Start

### 1. Install dependencies

Requires Python 3.9+ and PyTorch with MPS/CUDA support.

```bash
cd sparc-py
poetry install
```

Or with pip:

```bash
pip install -r requirements.txt
```

On Apple Silicon Macs, PyTorch uses MPS (Metal) automatically.
On Linux/Windows with an NVIDIA GPU, ensure CUDA-enabled PyTorch is installed.

### 2. Run the server

```bash
poetry run python server.py
```

Or without Poetry:

```bash
python server.py
```

The first run downloads:
- `microsoft/wavlm-large` (~1.2 GB) from Hugging Face
- `wavlm_large-9_cut-10_mngu_linear.pkl` (linear EMA weights)

Subsequent runs use the cached models.

### 3. Open the browser

Navigate to **http://localhost:8000** and click **Start Recording**.

## Files

| File | Description |
|------|-------------|
| `server.py` | WebSocket server (port 8765) + HTTP static file server (port 8000) |
| `sparc_realtime.py` | Real-time inference engine: WavLM + Butterworth + linear projection |
| `pyproject.toml` | Poetry project config and dependencies |
| `requirements.txt` | Pip-compatible dependencies (alternative to Poetry) |
| `static/index.html` | Browser UI |
| `static/app.js` | WebSocket client, audio capture, EMA-to-display mapping |
| `static/visualization.js` | SVG articulator rendering, demo animation |

## Articulators

Six articulators are tracked, each with x (anterior-posterior) and y (superior-inferior)
coordinates in z-scored MNGU0 EMA space:

| Abbreviation | Articulator |
|--------------|-------------|
| UL | Upper lip |
| LL | Lower lip |
| LI | Lower incisor (jaw) |
| TT | Tongue tip |
| TB | Tongue body |
| TD | Tongue dorsum |

## Latency

All times are approximate, measured on localhost:

| Stage | Time |
|-------|------|
| Audio chunk (browser → server) | ~100 ms |
| WebSocket round-trip | ~1 ms |
| WavLM inference (MPS / Apple Silicon) | ~50–150 ms |
| WavLM inference (CUDA) | ~30–80 ms |
| WavLM inference (CPU only) | ~300–600 ms |
| Butterworth filter + linear projection | <1 ms |
| **Total (MPS)** | **~150–250 ms** |
| **Total (CPU)** | **~400–700 ms** |

This is significantly faster than the browser-only WASM version (~900 ms+).

## Comparison with sparc-js

| Feature | sparc-js (Model) | sparc-js (Formant) | **sparc-py** |
|---------|------------------|--------------------|--------------|
| Inference | ONNX/WASM in browser | LPC formants in browser | Full PyTorch on server |
| WavLM | Truncated, layer 9 ONNX | None | Full `wavlm-large`, layer 9 |
| Butterworth filter | None | None | 10 Hz low-pass (`filtfilt`) |
| Tongue quality | Limited by WASM speed | F1+F2 interpolation | Full model quality |
| Latency | ~900 ms | ~50 ms | ~150–250 ms (MPS) |
| Requires Python | No | No | Yes |
| Requires GPU | No | No | No (but recommended) |

## Credits

Based on [Speech-Articulatory-Coding](https://github.com/Berkeley-Speech-Group/Speech-Articulatory-Coding)
by the Berkeley Speech Group.
