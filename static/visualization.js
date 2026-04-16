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

function setupVocalTractVisualization() {
  const svg = document.getElementById('vocal-tract-svg');
  if (!svg) {
    console.error("SVG element 'vocal-tract-svg' not found");
    return;
  }

  svg.setAttribute('viewBox', '-5 -5 9 9');
  svg.removeAttribute('width');
  svg.removeAttribute('height');

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  createReferenceGrid(svg);
  createContours(svg);
  createLegend(svg);
  createArticulatorMarkers(svg);
}

function createReferenceGrid(svg) {
  const grid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  grid.setAttribute('id', 'reference-grid');
  grid.setAttribute('opacity', '0.15');

  for (let y = -5; y <= 4; y++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '-5'); line.setAttribute('y1', y);
    line.setAttribute('x2', '4');  line.setAttribute('y2', y);
    line.setAttribute('stroke', y === 0 ? '#666' : '#999');
    line.setAttribute('stroke-width', '0.03');
    grid.appendChild(line);
  }

  for (let x = -5; x <= 4; x++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);  line.setAttribute('y1', '-5');
    line.setAttribute('x2', x);  line.setAttribute('y2', '4');
    line.setAttribute('stroke', x === 0 ? '#666' : '#999');
    line.setAttribute('stroke-width', '0.03');
    grid.appendChild(line);
  }

  svg.appendChild(grid);

  // MNGU0: +x = anterior, +y = inferior; SVG: +x = right, +y = down
  addSvgLabel(svg, 'FRONT', 3.0, 0.3);
  addSvgLabel(svg, 'BACK', -4.2, 0.3);
  addSvgLabel(svg, 'UP', 0.2, -4.5);
  addSvgLabel(svg, 'DOWN', 0.2, 3.8);
}

function createLegend(svg) {
  const legend = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  legend.setAttribute('id', 'legend');

  const order = ['ul', 'll', 'li', 'tt', 'tb', 'td'];

  order.forEach((id, i) => {
    const art = ARTICULATOR_COLORS[id];

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', -4.8);
    circle.setAttribute('cy', -4.6 + i * 0.5);
    circle.setAttribute('r', '0.1');
    circle.setAttribute('fill', art.fill);
    circle.setAttribute('stroke', art.stroke);
    circle.setAttribute('stroke-width', '0.03');
    legend.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', -4.55);
    text.setAttribute('y', -4.6 + i * 0.5);
    text.style.fontSize = '0.22px';
    text.style.fill = '#333';
    text.style.textAnchor = 'start';
    text.style.dominantBaseline = 'central';
    text.textContent = art.label;
    legend.appendChild(text);
  });

  svg.appendChild(legend);
}

function createContours(svg) {
  // Tongue body (filled shape behind markers)
  const tongue = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tongue.setAttribute('id', 'tongue-contour');
  tongue.setAttribute('fill', 'rgba(220, 150, 150, 0.35)');
  tongue.setAttribute('stroke', '#c07070');
  tongue.setAttribute('stroke-width', '0.05');
  tongue.setAttribute('stroke-linejoin', 'round');
  tongue.setAttribute('stroke-linecap', 'round');
  svg.appendChild(tongue);

  // Upper lip shape
  const ulContour = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ulContour.setAttribute('id', 'ul-contour');
  ulContour.setAttribute('fill', 'rgba(183, 28, 28, 0.3)');
  ulContour.setAttribute('stroke', '#b71c1c');
  ulContour.setAttribute('stroke-width', '0.04');
  ulContour.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(ulContour);

  // Lower lip shape
  const llContour = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  llContour.setAttribute('id', 'll-contour');
  llContour.setAttribute('fill', 'rgba(239, 154, 154, 0.3)');
  llContour.setAttribute('stroke', '#c07070');
  llContour.setAttribute('stroke-width', '0.04');
  llContour.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(llContour);
}

function createArticulatorMarkers(svg) {
  const order = ['ul', 'll', 'li', 'tt', 'tb', 'td'];

  order.forEach(id => {
    const art = ARTICULATOR_COLORS[id];

    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    marker.setAttribute('id', `${id}-marker`);
    marker.setAttribute('r', '0.15');
    marker.setAttribute('fill', art.fill);
    marker.setAttribute('stroke', art.stroke);
    marker.setAttribute('stroke-width', '0.03');
    marker.setAttribute('class', 'articulator-marker');
    svg.appendChild(marker);
  });
}

function addSvgLabel(svg, text, x, y) {
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('class', 'grid-label');
  label.setAttribute('x', x);
  label.setAttribute('y', y);
  label.textContent = text;
  svg.appendChild(label);
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

function updateContours() {
  const td = { x: smoothedFeatures.td_x, y: smoothedFeatures.td_y };
  const tb = { x: smoothedFeatures.tb_x, y: smoothedFeatures.tb_y };
  const tt = { x: smoothedFeatures.tt_x, y: smoothedFeatures.tt_y };
  const ul = { x: smoothedFeatures.ul_x, y: smoothedFeatures.ul_y };
  const ll = { x: smoothedFeatures.ll_x, y: smoothedFeatures.ll_y };

  // --- Tongue ---
  // Extend a root point behind TD (toward pharynx) and a tip past TT
  const root = { x: td.x - 0.5, y: td.y + 1.0 };
  const tipExt = { x: tt.x + 0.3, y: tt.y };

  // Top surface spline: root → TD → TB → TT → tip
  const topPoints = [root, td, tb, tt, tipExt];
  const topD = catmullRomPath(topPoints);

  // Bottom surface: offset downward, tapering from thick (back) to thin (tip)
  const botPoints = [
    { x: tipExt.x, y: tipExt.y + 0.15 },
    { x: tt.x,     y: tt.y + 0.3 },
    { x: tb.x,     y: tb.y + 0.5 },
    { x: td.x,     y: td.y + 0.7 },
    { x: root.x,   y: root.y + 0.4 }
  ];
  const botD = catmullRomPath(botPoints);

  const tongueD = topD +
    ` L ${botPoints[0].x.toFixed(3)} ${botPoints[0].y.toFixed(3)}` +
    botD.replace(/^M\s*[\d.\s-]+/, '') +
    ' Z';

  const tongueEl = document.getElementById('tongue-contour');
  if (tongueEl) tongueEl.setAttribute('d', tongueD);

  // --- Lips (half-ellipse shapes) ---
  const lipW = 0.4;
  const lipH = 0.3;

  // Upper lip: D-shape curving upward
  const ulD =
    `M ${(ul.x - lipW).toFixed(3)} ${ul.y.toFixed(3)}` +
    ` C ${(ul.x - lipW).toFixed(3)} ${(ul.y - lipH).toFixed(3)}` +
      ` ${(ul.x + lipW).toFixed(3)} ${(ul.y - lipH).toFixed(3)}` +
      ` ${(ul.x + lipW).toFixed(3)} ${ul.y.toFixed(3)} Z`;
  const ulEl = document.getElementById('ul-contour');
  if (ulEl) ulEl.setAttribute('d', ulD);

  // Lower lip: D-shape curving downward
  const llD =
    `M ${(ll.x - lipW).toFixed(3)} ${ll.y.toFixed(3)}` +
    ` C ${(ll.x - lipW).toFixed(3)} ${(ll.y + lipH).toFixed(3)}` +
      ` ${(ll.x + lipW).toFixed(3)} ${(ll.y + lipH).toFixed(3)}` +
      ` ${(ll.x + lipW).toFixed(3)} ${ll.y.toFixed(3)} Z`;
  const llEl = document.getElementById('ll-contour');
  if (llEl) llEl.setAttribute('d', llD);
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
// F1 values are canonical first-formant frequencies (Peterson & Barney, 1952),
// used to drive lip separation in the demo animation.
const VOWEL_Z_SCORES = {
  'i': { td:{x:-0.3,y: 0.5}, tb:{x: 0.5,y: 1.5}, tt:{x: 0.8,y: 0.8},
         li:{x: 0.0,y: 1.0}, ul:{x:0,y:0}, ll:{x:0,y:0}, _f1: 270 },
  'e': { td:{x:-0.2,y: 0.2}, tb:{x: 0.3,y: 0.8}, tt:{x: 0.5,y: 0.4},
         li:{x: 0.0,y: 0.3}, ul:{x:0,y:0}, ll:{x:0,y:0}, _f1: 530 },
  'a': { td:{x:-0.2,y:-1.2}, tb:{x: 0.0,y:-1.0}, tt:{x: 0.2,y:-0.5},
         li:{x: 0.0,y:-1.0}, ul:{x:0,y:0}, ll:{x:0,y:0}, _f1: 730 },
  'o': { td:{x:-0.5,y: 0.3}, tb:{x:-0.3,y: 0.2}, tt:{x: 0.0,y:-0.2},
         li:{x: 0.0,y:-0.3}, ul:{x:0,y:0}, ll:{x:0,y:0}, _f1: 570 },
  'u': { td:{x:-0.8,y: 1.0}, tb:{x:-0.5,y: 0.8}, tt:{x:-0.2,y: 0.2},
         li:{x: 0.0,y: 0.8}, ul:{x:0,y:0}, ll:{x:0,y:0}, _f1: 300 }
};

let VOWEL_POSITIONS = {};
function rebuildVowelPositions(zScoresMap) {
  for (const [vowel, zScores] of Object.entries(zScoresMap)) {
    VOWEL_POSITIONS[vowel] = {};

    const f1 = zScores._f1 || 0;

    for (const key of ['li', 'tt', 'tb', 'td']) {
      VOWEL_POSITIONS[vowel][key] = emaToDisplay(key, zScores[key].x, zScores[key].y);
    }

    for (const key of ['ul', 'll']) {
      VOWEL_POSITIONS[vowel][key] = emaToDisplay(key, zScores[key].x, zScores[key].y);
    }
    if (f1 > 0) {
      const lip = f1ToLipPositions(f1);
      VOWEL_POSITIONS[vowel].ul.y = lip.ulY;
      VOWEL_POSITIONS[vowel].ll.y = lip.llY;
    }

    const ulY = VOWEL_POSITIONS[vowel].ul.y;
    const llY = VOWEL_POSITIONS[vowel].ll.y;
    VOWEL_POSITIONS[vowel].jaw_opening = Math.min(1, Math.max(0,
      (Math.abs(llY - ulY) - 1.5) / 3));
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

function setupCharts() {
  setupVocalTractVisualization();
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
