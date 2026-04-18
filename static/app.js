/******************************************************************************
 * SPARC Python — Browser Client
 *
 * Captures microphone audio via Web Audio API, streams PCM over WebSocket
 * to the Python SPARC server, and maps returned EMA z-scores to SVG
 * display coordinates for visualization.
 *
 * No ML models are loaded in the browser — all inference runs server-side.
 ******************************************************************************/

/******************************************************************************
 * CONFIGURATION
 ******************************************************************************/
const config = {
  targetSampleRate: 16000,
  deviceSampleRate: null,
  frameSize: 512,
  chunkDuration: 0.1, // seconds of audio per WebSocket message
  wsUrl: `ws://${location.hostname || 'localhost'}:8765`
};

/******************************************************************************
 * GLOBAL STATE
 ******************************************************************************/

let audioContext;
let audioStream;
let workletNode;
let isRecording = false;

// WebSocket
let ws = null;
let wsConnected = false;

// Display bounds (MNGU0-derived SVG coordinate space)
const DISPLAY_MIN = -7.0;
const DISPLAY_MAX = 5.0;

let smoothedFeatures = {
  ul_x: 0, ul_y: 0,
  ll_x: 0, ll_y: 0,
  li_x: 0, li_y: 0,
  tt_x: 0, tt_y: 0,
  tb_x: 0, tb_y: 0,
  td_x: 0, td_y: 0,
  jaw_opening: 0
};

let smoothingFactor = 0.4;
const SILENCE_THRESHOLD_DB = -40;
const SILENCE_DECAY = 0.15;
let featureHistory = {};

let debugCounters = {
  audioDataReceived: 0,
  workerMessagesSent: 0,
  workerResponsesReceived: 0,
  featuresUpdated: 0,
  chartsUpdated: 0,
  errors: 0
};

let animationRunning = false;
let animationFrame = null;

// Audio chunk buffer: accumulate samples, send when we have chunkDuration worth
let chunkBuffer = new Float32Array(0);
let chunkTargetSamples = 1600; // recalculated at recording start

/******************************************************************************
 * UTILITY FUNCTIONS
 ******************************************************************************/

function debugLog(message, data = null) {
  const timestamp = new Date().toLocaleTimeString();
  if (data) {
    console.log(`[${timestamp}] SPARC-PY: ${message}`, data);
  } else {
    console.log(`[${timestamp}] SPARC-PY: ${message}`);
  }
}

function clampToDisplay(value) {
  return Math.max(DISPLAY_MIN, Math.min(DISPLAY_MAX, value));
}

function scaleToDisplay(value) {
  return clampToDisplay(value);
}

function updateStatus(message) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = message;

  if (message.includes('ERROR') || message.includes('CRITICAL')) {
    el.style.backgroundColor = '#ffebee';
    el.style.color = '#c62828';
    el.style.fontWeight = 'bold';
  } else if (message.includes('WARNING')) {
    el.style.backgroundColor = '#fff3e0';
    el.style.color = '#ef6c00';
  } else if (message.includes('Connected') || message.includes('Recording')) {
    el.style.backgroundColor = '#e8f5e8';
    el.style.color = '#2e7d32';
    el.style.fontWeight = 'normal';
  } else {
    el.style.backgroundColor = '#e9ecef';
    el.style.color = '#333';
    el.style.fontWeight = 'normal';
  }
}

function initializeFeatureHistory() {
  const keys = [
    'ul_x', 'ul_y', 'll_x', 'll_y', 'li_x', 'li_y',
    'tt_x', 'tt_y', 'tb_x', 'tb_y', 'td_x', 'td_y',
    'jaw_opening', 'pitch', 'loudness'
  ];
  featureHistory = {};
  keys.forEach(key => {
    featureHistory[key] = Array(100).fill(key === 'jaw_opening' ? 0.2 : 0);
  });
}

function calculateJawOpening(ul_y, ll_y) {
  const lipDistance = Math.abs(ll_y - ul_y);
  return Math.min(Math.max(lipDistance / 0.6, 0), 1);
}

/******************************************************************************
 * ARTICULATOR DISPLAY MAPPING
 *
 * Same constants & logic as sparc-js/app.js so positions are identical.
 ******************************************************************************/

// Rest positions derived from traced anatomy (head.svg → vocal-tract.svg)
// Uniform scale 0.0095 preserves original proportions
const ARTICULATOR_CENTERS = {
  td: { x: -0.53, y: -0.71 },   // tongue dorsum/root (traced pts 25-32)
  tb: { x:  1.29, y: -2.15 },   // tongue body (traced pts 18-24)
  tt: { x:  2.582, y: -1.562 },  // tongue tip (rightmost tongue pt; soft-clamped at teeth)
  li: { x:  2.69, y: -1.47 },   // lower incisor tip (traced lower-tooth pt 6)
  ul: { x:  3.00, y: -1.75 },   // upper lip inner edge (head profile pt 0, fixed)
  ll: { x:  3.00, y: -1.60 }    // lower lip (slightly below UL — average speech has lips parted)
};

// Palate ceiling at y ≈ -2.47, TB rest at y = -2.15 → gap = 0.32
// Scales must keep tongue below palate: max z * scale < gap
const DISPLAY_SCALES = {
  td: { x: 0.3, y: 0.3 },
  tb: { x: 0.3, y: 0.2 },       // y limited: 1.5 * 0.2 = 0.3 < 0.32 gap
  tt: { x: 0.3, y: 0.3 },
  li: { x: 0.2, y: 0.4 },
  ul: { x: 0.0, y: 0.0 },       // fixed — upper jaw doesn't move
  ll: { x: 0.2, y: 0.6 }        // LL carries all mouth opening
};

function emaToDisplay(key, z_x, z_y) {
  const c = ARTICULATOR_CENTERS[key];
  const s = DISPLAY_SCALES[key];
  return {
    x: c.x + z_x * s.x,
    y: c.y - z_y * s.y   // flip: MNGU0 +y = superior, SVG +y = down
  };
}

/******************************************************************************
 * F1-DRIVEN LIP POSITIONING (reference sounds only)
 ******************************************************************************/

const F1_CLOSED_HZ = 250;
const F1_OPEN_HZ   = 650;
const LIP_CLOSED_Y = -1.75;
const LIP_MAX_OPENING = 0.6;

function f1ToLipPositions(f1Hz) {
  const t = Math.max(0, Math.min(1, (f1Hz - F1_CLOSED_HZ) / (F1_OPEN_HZ - F1_CLOSED_HZ)));
  return {
    ulY: LIP_CLOSED_Y,                          // upper lip stays fixed
    llY: LIP_CLOSED_Y + t * LIP_MAX_OPENING     // only lower lip descends
  };
}

/******************************************************************************
 * WEBSOCKET CLIENT
 ******************************************************************************/

function connectWebSocket() {
  updateStatus('Connecting to server...');

  ws = new WebSocket(config.wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsConnected = true;
    updateStatus('Connected. Ready to record.');
    debugLog('WebSocket connected');

    const startBtn = document.getElementById('startButton');
    if (startBtn) startBtn.disabled = false;

    updateWsIndicator(true);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'features') {
        handleServerFeatures(message);
      }
    } catch (e) {
      debugLog('Error parsing server message', e);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateWsIndicator(false);
    debugLog('WebSocket closed, reconnecting in 2s...');
    updateStatus('Disconnected. Reconnecting...');

    const startBtn = document.getElementById('startButton');
    if (startBtn) startBtn.disabled = true;

    if (isRecording) stopRecording();
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (err) => {
    debugLog('WebSocket error', err);
  };
}

function updateWsIndicator(connected) {
  const dot = document.getElementById('ws-indicator-dot');
  const text = document.getElementById('ws-indicator-text');
  if (dot) dot.style.backgroundColor = connected ? '#4caf50' : '#f44336';
  if (text) text.textContent = connected ? 'Server connected' : 'Disconnected';
}

/******************************************************************************
 * HANDLE SERVER FEATURES
 ******************************************************************************/

function handleServerFeatures(message) {
  debugCounters.workerResponsesReceived++;

  try {
    const { articulationFeatures, loudness } = message;
    if (!articulationFeatures) return;

    // Log z-scores for diagnostics
    const tt = articulationFeatures.tt, tb = articulationFeatures.tb, td = articulationFeatures.td;
    debugLog(`EMA z: TT(${tt.x.toFixed(2)},${tt.y.toFixed(2)}) TB(${tb.x.toFixed(2)},${tb.y.toFixed(2)}) TD(${td.x.toFixed(2)},${td.y.toFixed(2)})`);

    const isSilent = (loudness || -60) < SILENCE_THRESHOLD_DB;

    // Map z-scores to display coordinates
    for (const key of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
      const z = articulationFeatures[key];
      if (!z || typeof z.x !== 'number' || typeof z.y !== 'number') continue;
      if (isSilent) {
        // Decay toward rest (center) position during silence
        const c = ARTICULATOR_CENTERS[key];
        articulationFeatures[key] = { x: c.x, y: c.y };
      } else {
        articulationFeatures[key] = emaToDisplay(key, z.x, z.y);
      }
    }

    const alpha = isSilent ? SILENCE_DECAY : smoothingFactor;
    updateFeatureHistory(articulationFeatures, 0, loudness || -60, alpha);
    updateStatus('Recording...');
    debugCounters.featuresUpdated++;

    requestAnimationFrame(() => {
      if (typeof updateCharts === 'function') {
        updateCharts();
      }
      debugCounters.chartsUpdated++;
    });
  } catch (error) {
    debugLog('Error handling server features', error);
    debugCounters.errors++;
  }
}

/******************************************************************************
 * FEATURE HISTORY & SMOOTHING
 ******************************************************************************/

function updateFeatureHistory(articulationFeatures, pitch, loudness, alphaOverride) {
  try {
    const alpha = alphaOverride != null ? alphaOverride : (isRecording ? smoothingFactor : 0.3);

    for (const art of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
      if (!articulationFeatures[art]) continue;

      let newX = articulationFeatures[art].x;
      let newY = articulationFeatures[art].y;
      if (!isFinite(newX) || !isFinite(newY)) continue;

      newX = scaleToDisplay(newX);
      newY = scaleToDisplay(newY);

      const oldX = smoothedFeatures[art + '_x'] || 0;
      const oldY = smoothedFeatures[art + '_y'] || 0;

      smoothedFeatures[art + '_x'] = clampToDisplay(alpha * newX + (1 - alpha) * oldX);
      smoothedFeatures[art + '_y'] = clampToDisplay(alpha * newY + (1 - alpha) * oldY);
    }

    const jawOpening = calculateJawOpening(smoothedFeatures.ul_y, smoothedFeatures.ll_y);
    smoothedFeatures.jaw_opening = alpha * jawOpening + (1 - alpha) * smoothedFeatures.jaw_opening;

    for (const key of Object.keys(featureHistory)) {
      featureHistory[key].shift();
      if (key === 'pitch') {
        featureHistory[key].push(isNaN(pitch) ? 0 : pitch);
      } else if (key === 'loudness') {
        featureHistory[key].push(isNaN(loudness) ? -60 : loudness);
      } else if (key === 'jaw_opening') {
        featureHistory[key].push(smoothedFeatures.jaw_opening);
      } else {
        const value = smoothedFeatures[key];
        featureHistory[key].push(isNaN(value) ? 0 : value);
      }
    }
  } catch (error) {
    debugLog('Error updating feature history', error);
    debugCounters.errors++;
  }
}

/******************************************************************************
 * AUDIO CAPTURE & STREAMING
 ******************************************************************************/

const audioProcessorCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    if (input && input.length > 0) {
      this.port.postMessage({ audio: input.slice() });
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

function resampleTo16k(samples, fromRate) {
  if (fromRate === config.targetSampleRate) return samples;

  const ratio = config.targetSampleRate / fromRate;
  const outLen = Math.round(samples.length * ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcIdx = i / ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

function onAudioData(rawSamples) {
  debugCounters.audioDataReceived++;

  // Resample to 16 kHz if needed
  const samples = resampleTo16k(rawSamples, config.deviceSampleRate || config.targetSampleRate);

  // Accumulate into chunk buffer
  const newBuf = new Float32Array(chunkBuffer.length + samples.length);
  newBuf.set(chunkBuffer);
  newBuf.set(samples, chunkBuffer.length);
  chunkBuffer = newBuf;

  // Send when we have enough
  while (chunkBuffer.length >= chunkTargetSamples) {
    const chunk = chunkBuffer.slice(0, chunkTargetSamples);
    chunkBuffer = chunkBuffer.slice(chunkTargetSamples);

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk.buffer);
      debugCounters.workerMessagesSent++;
    }
  }
}

async function startRecording() {
  try {
    debugLog('Starting recording...');

    animationRunning = false;
    if (animationFrame) { clearTimeout(animationFrame); animationFrame = null; }

    if (wsConnected && ws) {
      ws.send(JSON.stringify({ type: 'reset' }));
    }

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: config.targetSampleRate,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: config.targetSampleRate
    });

    config.deviceSampleRate = audioContext.sampleRate;
    chunkTargetSamples = Math.floor(config.targetSampleRate * config.chunkDuration);
    chunkBuffer = new Float32Array(0);

    debugLog(`Audio context: ${audioContext.sampleRate} Hz` +
      (audioContext.sampleRate !== config.targetSampleRate
        ? ` (resampling to ${config.targetSampleRate} Hz)` : ''));

    if (audioContext.audioWorklet) {
      const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
      await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));

      workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
      workletNode.port.onmessage = (event) => {
        if (event.data.audio) onAudioData(event.data.audio);
      };

      const source = audioContext.createMediaStreamSource(audioStream);
      source.connect(workletNode);
    } else {
      const source = audioContext.createMediaStreamSource(audioStream);
      const processor = audioContext.createScriptProcessor(config.frameSize, 1, 1);
      processor.onaudioprocess = (event) => {
        onAudioData(event.inputBuffer.getChannelData(0));
      };
      source.connect(processor);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      workletNode = processor;
    }

    isRecording = true;
    document.getElementById('startButton').disabled = true;
    document.getElementById('stopButton').disabled = false;
    updateStatus('Recording...');

  } catch (error) {
    debugLog('Error starting recording', error);
    updateStatus('Error: ' + error.message);
  }
}

function stopRecording() {
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
  }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }

  isRecording = false;
  chunkBuffer = new Float32Array(0);

  const startBtn = document.getElementById('startButton');
  const stopBtn = document.getElementById('stopButton');
  if (startBtn) startBtn.disabled = !wsConnected;
  if (stopBtn) stopBtn.disabled = true;

  updateStatus('Recording stopped.');

  if (!animationRunning && typeof testArticulatorAnimation === 'function') {
    testArticulatorAnimation();
  }
}

/******************************************************************************
 * INITIALIZATION
 ******************************************************************************/

async function init() {
  updateStatus('Connecting to server...');
  initializeFeatureHistory();

  if (typeof setupCharts === 'function') await setupCharts();
  if (typeof setupSensitivityControls === 'function') setupSensitivityControls();

  const startBtn = document.getElementById('startButton');
  const stopBtn = document.getElementById('stopButton');
  if (startBtn) startBtn.addEventListener('click', startRecording);
  if (stopBtn) stopBtn.addEventListener('click', stopRecording);

  const markersToggle = document.getElementById('markers-toggle');
  if (markersToggle) {
    function setMarkersVisible(visible) {
      document.querySelectorAll('.articulator-marker').forEach(m => {
        m.style.display = visible ? '' : 'none';
      });
      const legend = document.getElementById('legend');
      if (legend) legend.style.display = visible ? '' : 'none';
    }
    setMarkersVisible(markersToggle.checked);
    markersToggle.addEventListener('change', () => setMarkersVisible(markersToggle.checked));
  }

  connectWebSocket();
}

document.addEventListener('DOMContentLoaded', function() {
  init().catch(error => {
    console.error('Initialization error:', error);
    updateStatus('Initialization error: ' + error.message);
  });
});
