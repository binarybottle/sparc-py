#!/usr/bin/env python3
"""
SPARC real-time server.

- HTTP on port 8000: serves static files from ./static/
- WebSocket on port 8765: receives PCM audio, returns EMA z-scores

Usage:
    python server.py
"""

import asyncio
import json
import threading
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer

import numpy as np
import websockets

from sparc_realtime import RealtimeSPARC, ARTICULATORS

STATIC_DIR = Path(__file__).parent / "static"
HTTP_PORT = 8000
WS_PORT = 8765


# ---------------------------------------------------------------------------
# HTTP server (runs in a background thread)
# ---------------------------------------------------------------------------

class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


def run_http_server():
    with TCPServer(("", HTTP_PORT), StaticHandler) as httpd:
        httpd.serve_forever()


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

engine = None  # type: RealtimeSPARC | None


def load_engine() -> RealtimeSPARC:
    global engine
    if engine is None:
        engine = RealtimeSPARC()
    return engine


async def handle_ws(ws):
    """Handle one WebSocket connection (one browser tab)."""
    sparc = load_engine()
    sparc.reset()
    print(f"[WS] Client connected from {ws.remote_address}")

    try:
        async for message in ws:
            if isinstance(message, bytes):
                pcm = np.frombuffer(message, dtype=np.float32).copy()

                result = sparc.feed_audio(pcm)
                if result is None:
                    continue

                # Build the response matching the sparc-js interface:
                # { type, articulationFeatures: { ul:{x,y}, ... }, loudness }
                # We send the *last* frame (most recent) as the primary feature set.
                last_frame = result["ema"][-1]

                art_features = {}
                for art in ARTICULATORS:
                    art_features[art] = {
                        "x": last_frame[f"{art}_x"],
                        "y": last_frame[f"{art}_y"],
                    }

                payload = json.dumps({
                    "type": "features",
                    "articulationFeatures": art_features,
                    "loudness": result["loudness"],
                    "n_new_frames": result["n_new_frames"],
                })

                await ws.send(payload)

            elif isinstance(message, str):
                data = json.loads(message)
                if data.get("type") == "reset":
                    sparc.reset()
                    await ws.send(json.dumps({"type": "reset_ack"}))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print(f"[WS] Client disconnected from {ws.remote_address}")


async def main():
    # Start HTTP server in background thread
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()
    print(f"[HTTP] Serving static files on http://localhost:{HTTP_PORT}")

    # Load SPARC model eagerly so the first WS connection is fast
    print("[SPARC] Pre-loading models...")
    load_engine()
    print("[SPARC] Ready.")

    # Start WebSocket server
    async with websockets.serve(handle_ws, "0.0.0.0", WS_PORT):
        print(f"[WS] Listening on ws://localhost:{WS_PORT}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
