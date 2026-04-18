/******************************************************************************
 * SPARC Python — Vocal Tract Visualization
 *
 * Renders articulatory feature positions as colored markers on an SVG grid.
 * Manages vowel reference positions, demo animation, test sound display,
 * and smoothing controls.
 *
 * Depends on global state from app.js:
 *   smoothedFeatures, featureHistory, debugCounters,
 *   smoothingFactor, isRecording, animationRunning, animationFrame,
 *   DISPLAY_MIN, DISPLAY_MAX, ARTICULATOR_CENTERS, DISPLAY_SCALES,
 *   emaToDisplay, f1ToLipPositions, scaleToDisplay, clampToDisplay,
 *   updateFeatureHistory, calculateJawOpening, updateStatus, debugLog
 ******************************************************************************/

/******************************************************************************
 * ARTICULATOR COLOR MAP
 ******************************************************************************/

const ARTICULATOR_COLORS = {
  ul: { fill: '#b71c1c', stroke: '#fff', label: 'UL (upper lip)' },
  ll: { fill: '#ef9a9a', stroke: '#fff', label: 'LL (lower lip)' },
  li: { fill: '#ffffff', stroke: '#333', label: 'LI (lower incisor)' },
  tt: { fill: '#0d47a1', stroke: '#fff', label: 'TT (tongue tip)' },
  tb: { fill: '#1976d2', stroke: '#fff', label: 'TB (tongue body)' },
  td: { fill: '#64b5f6', stroke: '#fff', label: 'TD (tongue dorsum)' }
};

/******************************************************************************
 * SVG SETUP
 ******************************************************************************/

async function setupVocalTractVisualization() {
  const svg = document.getElementById('vocal-tract-svg');
  if (!svg) {
    console.error("SVG element 'vocal-tract-svg' not found");
    return;
  }

  svg.setAttribute('viewBox', '-2 -3.5 6 5');
  svg.removeAttribute('width');
  svg.removeAttribute('height');

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  await loadTracedAnatomy(svg);
  createContours(svg);
  createLegend(svg);
  createArticulatorMarkers(svg);
}

function anatomyLabel(parent, text, x, y, anchor) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.style.fontSize = '0.18px';
  el.style.fill = '#999';
  el.style.fontFamily = 'Arial, sans-serif';
  el.style.fontStyle = 'italic';
  el.style.textAnchor = anchor || 'middle';
  el.style.dominantBaseline = 'middle';
  el.textContent = text;
  parent.appendChild(el);
}

async function loadTracedAnatomy(svg) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'static-anatomy');

  // Style map: layer name → SVG style attributes
  const styles = {
    'head-and-neck':       { stroke: '#555', strokeWidth: '7',  fill: 'none' },
    'lower-jaw':           { stroke: '#555', strokeWidth: '7',  fill: 'none' },
    'palate':              { stroke: '#888', strokeWidth: '5',  fill: 'none' },
    'throat-nasal-cavity': { stroke: '#888', strokeWidth: '5',  fill: 'none' },
    'epiglottis':          { stroke: '#888', strokeWidth: '5',  fill: 'none' },
    'upper-tooth':         { stroke: '#999', strokeWidth: '8',  fill: 'none' },
    'lower-tooth':         { stroke: '#999', strokeWidth: '8',  fill: 'none' },
    'tongue':              { skip: true }
  };

  // Lower jaw goes in a dynamic group
  const jawGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  jawGroup.setAttribute('id', 'lower-jaw-group');

  try {
    const resp = await fetch('vocal-tract.svg');
    const text = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');

    const tracedGroup = doc.querySelector('#traced-anatomy');
    if (!tracedGroup) { console.error('No #traced-anatomy in vocal-tract.svg'); return; }

    const transform = tracedGroup.getAttribute('transform');

    // Create a group with the same transform
    const tg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    tg.setAttribute('transform', transform);
    tg.setAttribute('stroke-linecap', 'round');
    tg.setAttribute('stroke-linejoin', 'round');

    // Separate group for lower jaw (same base transform, dynamic offset added later)
    const tjaw = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    tjaw.setAttribute('transform', transform);
    tjaw.setAttribute('stroke-linecap', 'round');
    tjaw.setAttribute('stroke-linejoin', 'round');

    for (const path of tracedGroup.querySelectorAll('path')) {
      const id = path.getAttribute('id');
      const d = path.getAttribute('d');
      const style = styles[id] || { stroke: '#aaa', strokeWidth: '4', fill: 'none' };

      if (style.skip) continue;

      const newPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      newPath.setAttribute('d', d);
      newPath.setAttribute('fill', style.fill || 'none');
      newPath.setAttribute('stroke', style.stroke || '#888');
      newPath.setAttribute('stroke-width', style.strokeWidth || '5');

      if (id === 'lower-jaw' || id === 'lower-tooth') {
        tjaw.appendChild(newPath);
      } else {
        tg.appendChild(newPath);
      }
    }

    g.appendChild(tg);
    jawGroup.appendChild(tjaw);
    g.appendChild(jawGroup);

  } catch (e) {
    console.error('Failed to load vocal-tract.svg:', e);
  }


  svg.appendChild(g);
}

function createLegend(svg) {
  const legend = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  legend.setAttribute('id', 'legend');

  const order = ['ul', 'll', 'li', 'tt', 'tb', 'td'];

  order.forEach((id, i) => {
    const art = ARTICULATOR_COLORS[id];

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', -1.85);
    circle.setAttribute('cy', -3.35 + i * 0.15);
    circle.setAttribute('r', '0.04');
    circle.setAttribute('fill', art.fill);
    circle.setAttribute('stroke', art.stroke);
    circle.setAttribute('stroke-width', '0.01');
    legend.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', -1.77);
    text.setAttribute('y', -3.35 + i * 0.15);
    text.style.fontSize = '0.1px';
    text.style.fill = '#333';
    text.style.textAnchor = 'start';
    text.style.dominantBaseline = 'central';
    text.textContent = art.label;
    legend.appendChild(text);
  });

  svg.appendChild(legend);
}

// 33 tongue surface points in SVG coordinate space (tip → root),
// extracted from head.svg traced tongue via uniform matrix(0.0095,0,0,0.0095,-0.7335,-9.768)
const TONGUE_BASE_POINTS = [
  {x:1.932,y:-0.891},{x:1.953,y:-0.891},{x:2.027,y:-0.919},{x:2.084,y:-0.975},
  {x:2.184,y:-1.101},{x:2.249,y:-1.151},{x:2.309,y:-1.206},{x:2.372,y:-1.332},
  {x:2.477,y:-1.437},{x:2.548,y:-1.486},{x:2.574,y:-1.520},{x:2.582,y:-1.562},
  {x:2.566,y:-1.606},{x:2.540,y:-1.646},{x:2.513,y:-1.732},{x:2.477,y:-1.814},
  {x:2.418,y:-1.861},{x:2.351,y:-1.898},{x:2.205,y:-2.045},{x:2.016,y:-2.108},
  {x:1.785,y:-2.129},{x:1.449,y:-2.213},{x:1.050,y:-2.213},{x:0.505,y:-2.234},
  {x:0.001,y:-2.108},{x:-0.293,y:-1.877},{x:-0.444,y:-1.563},{x:-0.545,y:-1.227},
  {x:-0.671,y:-0.849},{x:-0.671,y:-0.492},{x:-0.629,y:-0.156},{x:-0.503,y:0.179},
  {x:-0.482,y:0.326}
];

function createContours(svg) {
  const tongue = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tongue.setAttribute('id', 'tongue-contour');
  tongue.setAttribute('fill', 'rgba(220, 150, 150, 0.35)');
  tongue.setAttribute('stroke', '#c07070');
  tongue.setAttribute('stroke-width', '0.03');
  tongue.setAttribute('stroke-linejoin', 'round');
  tongue.setAttribute('stroke-linecap', 'round');
  svg.appendChild(tongue);
}

function createArticulatorMarkers(svg) {
  const order = ['ul', 'll', 'li', 'tt', 'tb', 'td'];

  order.forEach(id => {
    const art = ARTICULATOR_COLORS[id];

    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    marker.setAttribute('id', `${id}-marker`);
    marker.setAttribute('r', '0.08');
    marker.setAttribute('fill', art.fill);
    marker.setAttribute('stroke', art.stroke);
    marker.setAttribute('stroke-width', '0.03');
    marker.setAttribute('class', 'articulator-marker');
    svg.appendChild(marker);
  });
}

/******************************************************************************
 * CONTOUR RENDERING (tongue body + lip shapes)
 ******************************************************************************/

function catmullRomPath(points) {
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(3)} ${cp1y.toFixed(3)} ${cp2x.toFixed(3)} ${cp2y.toFixed(3)} ${p2.x.toFixed(3)} ${p2.y.toFixed(3)}`;
  }
  return d;
}

// Palate lower boundary (piecewise linear from traced palate path)
const PALATE_CEIL = [
  [-0.5, -2.40], [0.2, -2.44], [0.7, -2.46], [1.0, -2.46],
  [1.5, -2.46], [1.8, -2.44], [2.1, -2.32], [2.3, -2.15], [2.5, -1.98]
];
const PALATE_MARGIN = 0.06;

// Smooth teeth boundary: tongue approaches but never exceeds the back of the upper tooth.
// Uses tanh compression so the tip keeps its curved shape instead of flattening.
const TEETH_COMPRESS_START = 2.45;  // where compression begins (just before tip)
const TEETH_BACK_X = 2.63;         // back surface of upper front tooth
const TEETH_RANGE = TEETH_BACK_X - TEETH_COMPRESS_START;  // 0.18

function softClampTeethX(x) {
  if (x <= TEETH_COMPRESS_START) return x;
  const excess = x - TEETH_COMPRESS_START;
  return TEETH_COMPRESS_START + TEETH_RANGE * Math.tanh(excess / TEETH_RANGE);
}

function getPalateCeiling(x) {
  const pts = PALATE_CEIL;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    if (x <= pts[i + 1][0]) {
      const frac = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + frac * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return -2.0;
}

function updateContours() {
  const td = { x: smoothedFeatures.td_x, y: smoothedFeatures.td_y };
  const tb = { x: smoothedFeatures.tb_x, y: smoothedFeatures.tb_y };
  const tt = { x: smoothedFeatures.tt_x, y: smoothedFeatures.tt_y };
  const ulY = ARTICULATOR_CENTERS.ul.y;
  const ll = {
    x: smoothedFeatures.ll_x,
    y: Math.max(smoothedFeatures.ll_y, ulY)
  };

  // --- Deform traced tongue surface ---
  const ttOff = { x: tt.x - ARTICULATOR_CENTERS.tt.x, y: tt.y - ARTICULATOR_CENTERS.tt.y };
  const tbOff = { x: tb.x - ARTICULATOR_CENTERS.tb.x, y: tb.y - ARTICULATOR_CENTERS.tb.y };
  const tdOff = { x: td.x - ARTICULATOR_CENTERS.td.x, y: td.y - ARTICULATOR_CENTERS.td.y };

  const n = TONGUE_BASE_POINTS.length;
  const deformed = TONGUE_BASE_POINTS.map((bp, i) => {
    const t = i / (n - 1);  // 0 = upper surface start, ~0.34 = tip, 1 = root
    const wTT = Math.exp(-8 * (t - 0.34) * (t - 0.34));   // wide peak at tip
    const wTB = Math.exp(-12 * (t - 0.55) * (t - 0.55));
    const wTD = Math.exp(-12 * (t - 1.0) * (t - 1.0));
    let x = bp.x + ttOff.x * wTT + tbOff.x * wTB + tdOff.x * wTD;
    let y = bp.y + ttOff.y * wTT + tbOff.y * wTB + tdOff.y * wTD;

    // Smooth teeth boundary + palate ceiling
    x = softClampTeethX(x);
    const ceil = getPalateCeiling(x);
    if (y < ceil + PALATE_MARGIN) y = ceil + PALATE_MARGIN;

    return { x, y };
  });

  const tongueD = catmullRomPath(deformed);
  const tongueEl = document.getElementById('tongue-contour');
  if (tongueEl) tongueEl.setAttribute('d', tongueD);

  // --- Lower jaw: only opens (translates down), never closes past rest ---
  const jawGroup = document.getElementById('lower-jaw-group');
  if (jawGroup) {
    const restY = ARTICULATOR_CENTERS.ll.y;
    const jawOffset = Math.max(0, ll.y - restY);
    jawGroup.setAttribute('transform', `translate(0, ${jawOffset.toFixed(3)})`);
  }
}

/******************************************************************************
 * CHART / MARKER UPDATE
 ******************************************************************************/

function updateCharts() {
  try {
    if (!featureHistory || Object.keys(featureHistory).length === 0) return;

    const articulators = ['ul', 'll', 'li', 'tt', 'tb', 'td'];
    const latestFeatures = {};

    for (const art of articulators) {
      const xHist = featureHistory[art + '_x'];
      const yHist = featureHistory[art + '_y'];
      latestFeatures[art] = (xHist && yHist)
        ? { x: xHist[xHist.length - 1], y: yHist[yHist.length - 1] }
        : { x: 0, y: 0 };
    }

    // Clamp LL: lips stop when touching (LL.y never above UL.y)
    const ulY = ARTICULATOR_CENTERS.ul.y;
    if (latestFeatures.ll && latestFeatures.ll.y < ulY) {
      latestFeatures.ll.y = ulY;
      smoothedFeatures.ll_y = ulY;
    }

    // Soft-clamp TT marker to match tongue contour's teeth boundary
    if (latestFeatures.tt) {
      const clampedX = softClampTeethX(latestFeatures.tt.x);
      if (clampedX !== latestFeatures.tt.x) {
        latestFeatures.tt.x = clampedX;
        smoothedFeatures.tt_x = clampedX;
      }
    }

    for (const art of articulators) {
      const marker = document.getElementById(`${art}-marker`);
      if (!marker || !latestFeatures[art]) continue;

      marker.setAttribute('cx', clampToDisplay(latestFeatures[art].x || 0));
      marker.setAttribute('cy', clampToDisplay(latestFeatures[art].y || 0));
    }

    updateContours();
  } catch (error) {
    debugLog('Error in updateCharts', error);
    debugCounters.errors++;
  }
}

/******************************************************************************
 * DEFAULT POSITIONS & DEMO ANIMATION
 ******************************************************************************/

function stopAnimation() {
  animationRunning = false;
  if (animationFrame) {
    clearTimeout(animationFrame);
    animationFrame = null;
  }
}

function initializeDefaultPositions() {
  const defaultPositions = {};
  for (const key of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
    defaultPositions[key] = emaToDisplay(key, 0, 0);
  }

  Object.keys(defaultPositions).forEach(art => {
    smoothedFeatures[art + '_x'] = scaleToDisplay(defaultPositions[art].x);
    smoothedFeatures[art + '_y'] = scaleToDisplay(defaultPositions[art].y);
  });

  smoothedFeatures.jaw_opening = calculateJawOpening(defaultPositions.ul.y, defaultPositions.ll.y);

  if (featureHistory && Object.keys(featureHistory).length > 0) {
    for (let i = 0; i < 100; i++) {
      Object.keys(defaultPositions).forEach(art => {
        if (featureHistory[art + '_x']) featureHistory[art + '_x'][i] = smoothedFeatures[art + '_x'];
        if (featureHistory[art + '_y']) featureHistory[art + '_y'][i] = smoothedFeatures[art + '_y'];
      });
      if (featureHistory.jaw_opening) featureHistory.jaw_opening[i] = smoothedFeatures.jaw_opening;
    }
    updateCharts();
  }
}

// Phonetically-motivated z-scores for demo/reference vowel positions.
// LL y < 0 opens the jaw; the more negative, the wider.
// TT y > 0 = tip up, y < 0 = tip down (behind lower teeth).
const VOWEL_Z_SCORES = {
  'i': { td:{x:-0.3,y: 0.5}, tb:{x: 0.5,y: 1.5}, tt:{x: 0.3,y:-0.5},
         li:{x: 0.0,y: 0.5}, ul:{x:0,y:0}, ll:{x:0,y: 0.0} },
  'e': { td:{x:-0.2,y: 0.2}, tb:{x: 0.3,y: 0.8}, tt:{x: 0.3,y:-0.2},
         li:{x: 0.0,y: 0.3}, ul:{x:0,y:0}, ll:{x:0,y:-0.4} },
  'a': { td:{x:-0.2,y:-1.2}, tb:{x: 0.0,y:-1.0}, tt:{x: 0.2,y:-0.5},
         li:{x: 0.0,y:-1.0}, ul:{x:0,y:0}, ll:{x:0,y:-1.5} },
  'o': { td:{x:-0.5,y: 0.3}, tb:{x:-0.3,y: 0.0}, tt:{x: 0.0,y:-0.3},
         li:{x: 0.0,y:-0.3}, ul:{x:0,y:0}, ll:{x:0,y:-0.7} },
  'u': { td:{x:-0.8,y: 1.0}, tb:{x:-0.5,y: 0.8}, tt:{x: 0.0,y:-0.3},
         li:{x: 0.0,y: 0.5}, ul:{x:0,y:0}, ll:{x:0,y:-0.3} }
};

let VOWEL_POSITIONS = {};
function rebuildVowelPositions(zScoresMap) {
  for (const [vowel, zScores] of Object.entries(zScoresMap)) {
    VOWEL_POSITIONS[vowel] = {};

    for (const key of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
      VOWEL_POSITIONS[vowel][key] = emaToDisplay(key, zScores[key].x, zScores[key].y);
    }

    const ulY = VOWEL_POSITIONS[vowel].ul.y;
    const llY = VOWEL_POSITIONS[vowel].ll.y;
    VOWEL_POSITIONS[vowel].jaw_opening = Math.min(1, Math.max(0,
      Math.abs(llY - ulY) / 0.8));
  }
}
rebuildVowelPositions(VOWEL_Z_SCORES);

function testArticulatorAnimation() {
  const vowelSequence = ['i', 'a', 'u'];

  let frame = 0;
  const frameDuration = 800;
  const frameTransitions = 30;
  animationRunning = true;

  function animateFrame() {
    if (!document.getElementById('vocal-tract-svg') || isRecording || !animationRunning) {
      animationRunning = false;
      return;
    }

    const currentIdx = Math.floor(frame / frameTransitions) % vowelSequence.length;
    const nextIdx = (currentIdx + 1) % vowelSequence.length;
    const t = (frame % frameTransitions) / frameTransitions;

    const curr = VOWEL_POSITIONS[vowelSequence[currentIdx]];
    const next = VOWEL_POSITIONS[vowelSequence[nextIdx]];

    const features = {};
    for (const art of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
      features[art] = {
        x: curr[art].x + (next[art].x - curr[art].x) * t,
        y: curr[art].y + (next[art].y - curr[art].y) * t
      };
    }

    smoothedFeatures.jaw_opening = curr.jaw_opening + (next.jaw_opening - curr.jaw_opening) * t;

    updateFeatureHistory(features, 0, -60);
    updateCharts();

    if (frame % frameTransitions === 0) {
      const vowel = vowelSequence[currentIdx];
      updateStatus(`Demo: /${vowel}/`);
    }

    frame++;
    animationFrame = setTimeout(animateFrame, frameDuration / frameTransitions);
  }

  animateFrame();
}

/******************************************************************************
 * CONTROLS SETUP
 ******************************************************************************/

async function setupCharts() {
  await setupVocalTractVisualization();
  initializeDefaultPositions();
  if (!isRecording) {
    testArticulatorAnimation();
  }
}

function setupSensitivityControls() {
  const smoothingSlider = document.getElementById('smoothing-slider');
  const smoothingValue = document.getElementById('smoothing-value');
  if (smoothingSlider) {
    smoothingSlider.addEventListener('input', function() {
      smoothingFactor = parseFloat(this.value);
      if (smoothingValue) smoothingValue.textContent = smoothingFactor.toFixed(1);
    });
  }

  const soundSelector = document.getElementById('sound-selector');
  if (soundSelector) {
    soundSelector.addEventListener('change', function() {
      if (isRecording) {
        alert('Stop recording first to test sounds');
        soundSelector.value = '';
        return;
      }

      stopAnimation();

      const vowel = soundSelector.value;
      if (vowel && VOWEL_POSITIONS[vowel]) {
        const pos = VOWEL_POSITIONS[vowel];
        updateStatus(`/${vowel}/`);

        for (const art of ['ul', 'll', 'li', 'tt', 'tb', 'td']) {
          if (!pos[art]) continue;
          const sx = scaleToDisplay(pos[art].x);
          const sy = scaleToDisplay(pos[art].y);
          smoothedFeatures[art + '_x'] = sx;
          smoothedFeatures[art + '_y'] = sy;
          if (featureHistory[art + '_x']) featureHistory[art + '_x'][featureHistory[art + '_x'].length - 1] = sx;
          if (featureHistory[art + '_y']) featureHistory[art + '_y'][featureHistory[art + '_y'].length - 1] = sy;
        }
        smoothedFeatures.jaw_opening = pos.jaw_opening;
        updateCharts();
      } else if (!vowel) {
        testArticulatorAnimation();
      }
    });
  }
}
