/**
 * Interaction
 *
 * Desktop: mouse click → HTML detail panel (unchanged).
 * VR: gaze (head direction) highlights spheres, pinch selects → 3D panel.
 * Close button on the 3D panel to dismiss (gaze + pinch).
 * Two-hand pinch: zoom/rotate marketsGroup. Head is fully decoupled.
 */

import * as THREE from 'three';
import { scene, camera, renderer, controllers, hands } from './scene.js';
import { getMarketMeshes, getMarketsGroup } from './visualization.js';

// ---- DOM refs ---------------------------------------------------------------

const detailPanel = document.getElementById('detail-panel');
const detailTitle = document.getElementById('detail-title');
const detailOutcomes = document.getElementById('detail-outcomes');
const detailMeta = document.getElementById('detail-meta');
const detailClose = document.getElementById('detail-close');

// ---- Raycaster --------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();

// ---- Helpers ----------------------------------------------------------------

function getMeshList() {
  const meshes = [];
  for (const entry of getMarketMeshes().values()) meshes.push(entry.sphere);
  return meshes;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatVolume(v) {
  if (v == null) return '--';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function timeUntil(dateStr) {
  const ms = new Date(dateStr) - Date.now();
  if (ms <= 0) return 'Resolving now';
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} months`;
}

// ---- Desktop interaction (unchanged) ----------------------------------------

function onPointerDown(e) {
  if (renderer.xr.isPresenting) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(getMeshList(), false);
  if (intersects.length > 0) {
    showHTMLDetail(intersects[0].object.userData.eventId);
  } else {
    hideHTMLDetail();
  }
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);

detailClose.addEventListener('click', (e) => {
  e.stopPropagation();
  hideHTMLDetail();
});

// ---- HTML Detail Panel (desktop) --------------------------------------------

function showHTMLDetail(eventId) {
  const entry = getMarketMeshes().get(eventId);
  if (!entry) return;
  const event = entry.event;

  detailTitle.textContent = event.title;

  detailOutcomes.innerHTML = '';
  const seen = new Map();
  for (const outcome of event.outcomes) {
    const existing = seen.get(outcome.name);
    if (!existing || (outcome.price || 0) > (existing.price || 0)) {
      seen.set(outcome.name, outcome);
    }
  }
  const deduped = Array.from(seen.values())
    .filter(o => o.price != null && o.price > 0.005)
    .sort((a, b) => (b.price || 0) - (a.price || 0));
  const MAX_OUTCOMES = 6;
  const shown = deduped.slice(0, MAX_OUTCOMES);

  for (const outcome of shown) {
    const pct = Math.round(outcome.price * 100);
    const hue = Math.min(Math.max(outcome.price, 0), 1) * 120;
    const row = document.createElement('div');
    row.className = 'outcome-row';
    row.innerHTML = `
      <span class="outcome-name">${escapeHTML(outcome.name)}</span>
      <div class="outcome-bar-bg">
        <div class="outcome-bar-fill" style="width:${pct}%; background:hsl(${hue},70%,50%)"></div>
      </div>
      <span class="outcome-pct">${pct}%</span>
    `;
    detailOutcomes.appendChild(row);
  }
  if (deduped.length > MAX_OUTCOMES) {
    const more = document.createElement('div');
    more.className = 'outcome-name';
    more.style.marginTop = '4px';
    more.style.opacity = '0.5';
    more.textContent = `+ ${deduped.length - MAX_OUTCOMES} more outcomes`;
    detailOutcomes.appendChild(more);
  }

  const vol24 = formatVolume(event.volume24hr);
  const volTotal = formatVolume(event.totalVolume);
  const timeLeft = event.endDate ? timeUntil(event.endDate) : 'No end date';
  const link = event.slug
    ? `<a href="https://polymarket.com/event/${encodeURIComponent(event.slug)}" target="_blank" rel="noopener">View on Polymarket</a>`
    : '';

  detailMeta.innerHTML = `
    Volume (24h): ${vol24} &nbsp;|&nbsp; Total: ${volTotal}<br>
    Resolution: ${timeLeft}<br>
    ${link}
  `;

  detailPanel.classList.add('visible');
}

function hideHTMLDetail() {
  detailPanel.classList.remove('visible');
}

// ---- 3D VR Detail Panel -----------------------------------------------------

const PANEL_W = 1.2;
const PANEL_H = 0.8;
const CANVAS_W = 800;
const CANVAS_H = 500;

const panelCanvas = document.createElement('canvas');
panelCanvas.width = CANVAS_W;
panelCanvas.height = CANVAS_H;
const panelCtx = panelCanvas.getContext('2d');

const panelTexture = new THREE.CanvasTexture(panelCanvas);

const panelMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(PANEL_W, PANEL_H),
  new THREE.MeshBasicMaterial({
    map: panelTexture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);

const vrDetailGroup = new THREE.Group();
vrDetailGroup.add(panelMesh);
vrDetailGroup.visible = false;
scene.add(vrDetailGroup);

// ---- VR Panel Close Button --------------------------------------------------

const CLOSE_BTN_SIZE = 0.1; // 10cm — easy gaze target

const closeBtnCanvas = document.createElement('canvas');
closeBtnCanvas.width = 64;
closeBtnCanvas.height = 64;
const closeBtnCtx = closeBtnCanvas.getContext('2d');

// Draw red circle with X
closeBtnCtx.fillStyle = 'rgba(200, 50, 50, 1.0)';
closeBtnCtx.beginPath();
closeBtnCtx.arc(32, 32, 28, 0, Math.PI * 2);
closeBtnCtx.fill();
closeBtnCtx.strokeStyle = '#fff';
closeBtnCtx.lineWidth = 5;
closeBtnCtx.lineCap = 'round';
closeBtnCtx.beginPath();
closeBtnCtx.moveTo(20, 20);
closeBtnCtx.lineTo(44, 44);
closeBtnCtx.moveTo(44, 20);
closeBtnCtx.lineTo(20, 44);
closeBtnCtx.stroke();

const closeBtnTexture = new THREE.CanvasTexture(closeBtnCanvas);
const closeBtnMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(CLOSE_BTN_SIZE, CLOSE_BTN_SIZE),
  new THREE.MeshBasicMaterial({
    map: closeBtnTexture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
// Top-right corner of the panel, slightly in front to avoid z-fighting
closeBtnMesh.position.set(
  PANEL_W / 2 - CLOSE_BTN_SIZE / 2 - 0.02,
  PANEL_H / 2 - CLOSE_BTN_SIZE / 2 - 0.02,
  0.002,
);
vrDetailGroup.add(closeBtnMesh);

// ---- Panel canvas rendering -------------------------------------------------

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderPanelCanvas(event) {
  const ctx = panelCtx;
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = 'rgba(10, 12, 30, 0.92)';
  drawRoundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 24);
  ctx.fill();

  ctx.strokeStyle = 'rgba(80, 120, 255, 0.4)';
  ctx.lineWidth = 2;
  drawRoundRect(ctx, 1, 1, CANVAS_W - 2, CANVAS_H - 2, 24);
  ctx.stroke();

  ctx.fillStyle = '#e0e8ff';
  ctx.font = 'bold 30px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const title = event.title.length > 55 ? event.title.slice(0, 54) + '\u2026' : event.title;
  ctx.fillText(title, 30, 50);

  ctx.strokeStyle = 'rgba(80, 120, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(30, 68);
  ctx.lineTo(CANVAS_W - 30, 68);
  ctx.stroke();

  const seen = new Map();
  for (const o of event.outcomes) {
    const existing = seen.get(o.name);
    if (!existing || (o.price || 0) > (existing.price || 0)) seen.set(o.name, o);
  }
  const deduped = Array.from(seen.values())
    .filter(o => o.price != null && o.price > 0.005)
    .sort((a, b) => (b.price || 0) - (a.price || 0));
  const shown = deduped.slice(0, 6);

  let y = 100;
  for (const outcome of shown) {
    const pct = Math.round(outcome.price * 100);
    const hue = Math.min(Math.max(outcome.price, 0), 1) * 120;

    ctx.fillStyle = '#b0b8d0';
    ctx.font = '22px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    const name = outcome.name.length > 35 ? outcome.name.slice(0, 34) + '\u2026' : outcome.name;
    ctx.fillText(name, 30, y);

    const barY = y + 8;
    const barW = CANVAS_W - 120;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(30, barY, barW, 18);

    ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
    ctx.fillRect(30, barY, barW * pct / 100, 18);

    ctx.fillStyle = '#e0e8ff';
    ctx.font = 'bold 22px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${pct}%`, CANVAS_W - 30, y + 22);
    ctx.textAlign = 'left';

    y += 56;
  }

  ctx.fillStyle = '#6070a0';
  ctx.font = '18px -apple-system, sans-serif';
  const vol24 = formatVolume(event.volume24hr);
  const volTotal = formatVolume(event.totalVolume);
  const timeLeft = event.endDate ? timeUntil(event.endDate) : 'No end date';
  ctx.fillText(`Vol 24h: ${vol24}  \u00b7  Total: ${volTotal}  \u00b7  ${timeLeft}`, 30, CANVAS_H - 30);
}

function showVRDetail(eventId) {
  const entry = getMarketMeshes().get(eventId);
  if (!entry) return;

  renderPanelCanvas(entry.event);
  panelTexture.needsUpdate = true;

  // Position 1.5m in front of XR camera
  const xrCam = renderer.xr.getCamera();
  xrCam.getWorldPosition(_camPos);
  xrCam.getWorldDirection(_camDir);

  vrDetailGroup.position.copy(_camPos).add(_camDir.multiplyScalar(1.5));
  vrDetailGroup.lookAt(_camPos);
  vrDetailGroup.visible = true;
}

function hideVRDetail() {
  vrDetailGroup.visible = false;
}

// ---- Gaze reticle (small dot showing where user is looking) -----------------

const reticleMat = new THREE.MeshBasicMaterial({
  color: 0xaabbff,
  transparent: true,
  opacity: 0.6,
  depthTest: false,
  depthWrite: false,
});
const reticleMesh = new THREE.Mesh(
  new THREE.RingGeometry(0.006, 0.012, 24),
  reticleMat,
);
reticleMesh.visible = false;
scene.add(reticleMesh);

const RETICLE_DEFAULT_DIST = 5; // meters ahead when not hitting anything
const _reticlePos = new THREE.Vector3();

// ---- Gaze hover (XR camera forward direction) -------------------------------

const HOVER_SCALE_MULT = 1.15;
const HOVER_EMISSIVE_BOOST = 0.3;
let gazedSphere = null;

function updateGaze() {
  const xrCam = renderer.xr.getCamera();
  xrCam.getWorldPosition(_camPos);
  xrCam.getWorldDirection(_camDir);
  raycaster.set(_camPos, _camDir);

  const hits = raycaster.intersectObjects(getMeshList(), false);
  const hitObj = hits.length > 0 ? hits[0] : null;
  const newGazedSphere = hitObj ? hitObj.object : null;

  // Sphere hover
  if (gazedSphere && gazedSphere !== newGazedSphere) {
    gazedSphere._hovered = false;
  }
  if (newGazedSphere) {
    newGazedSphere._hovered = true;
    gazedSphere = newGazedSphere;
  } else if (gazedSphere) {
    gazedSphere._hovered = false;
    gazedSphere = null;
  }

  // Position gaze reticle
  if (hitObj) {
    _reticlePos.copy(hitObj.point);
    // Nudge toward camera to sit on surface
    _reticlePos.addScaledVector(_camDir, -0.01);
  } else {
    _reticlePos.copy(_camPos).addScaledVector(_camDir, RETICLE_DEFAULT_DIST);
  }
  reticleMesh.position.copy(_reticlePos);
  reticleMesh.lookAt(_camPos);
  reticleMesh.visible = true;
}

// ---- Pinch select (gaze + pinch) --------------------------------------------
// On any controller selectstart, check what gaze is pointed at:
//   - close button → dismiss panel
//   - sphere → show panel for that sphere

for (let i = 0; i < 4; i++) {
  controllers[i].addEventListener('selectstart', () => {
    // Skip selection when both hands are pinching (zoom/rotate gesture)
    if (pinchState.hands[0].pinching && pinchState.hands[1].pinching) return;

    // Use gaze direction for all selection
    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(_camPos);
    xrCam.getWorldDirection(_camDir);
    raycaster.set(_camPos, _camDir);

    // Gazing at a sphere → open/switch panel
    if (gazedSphere) {
      showVRDetail(gazedSphere.userData.eventId);
    } else if (vrDetailGroup.visible) {
      // Pinch in empty space (no sphere) → close panel
      hideVRDetail();
    }
  });
}

// ---- Two-Hand Pinch Zoom/Rotate ---------------------------------------------
// Only two-hand pinch manipulates the scene. No single-hand rotation.
// Head movement is fully decoupled from marketsGroup.

const PINCH_THRESHOLD = 0.04;

const pinchState = {
  hands: [
    { pinching: false, pos: new THREE.Vector3() },
    { pinching: false, pos: new THREE.Vector3() },
  ],
  twoHand: { active: false, initDist: 0, initAngle: 0, initRotY: 0, initMid: new THREE.Vector3(), initPos: new THREE.Vector3(), initForward: new THREE.Vector3(), initRight: new THREE.Vector3(), pivotPos: new THREE.Vector3() },
};

const _thumbPos = new THREE.Vector3();
const _indexPos = new THREE.Vector3();

function updatePinchGestures() {
  const marketsGroup = getMarketsGroup();

  for (let i = 0; i < 2; i++) {
    const hand = hands[i];
    const hs = pinchState.hands[i];

    if (!hand.joints) { hs.pinching = false; continue; }

    const thumbJoint = hand.joints['thumb-tip'];
    const indexJoint = hand.joints['index-finger-tip'];

    if (thumbJoint && indexJoint) {
      _thumbPos.setFromMatrixPosition(thumbJoint.matrixWorld);
      _indexPos.setFromMatrixPosition(indexJoint.matrixWorld);
      const dist = _thumbPos.distanceTo(_indexPos);
      hs.pinching = dist < PINCH_THRESHOLD;
      hs.pos.copy(_indexPos);
    } else {
      hs.pinching = false;
    }
  }

  const bothPinching = pinchState.hands[0].pinching && pinchState.hands[1].pinching;

  if (bothPinching) {
    const p0 = pinchState.hands[0].pos;
    const p1 = pinchState.hands[1].pos;
    const currentDist = p0.distanceTo(p1);
    const currentAngle = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const currentMid = new THREE.Vector3(
      (p0.x + p1.x) / 2,
      (p0.y + p1.y) / 2,
      (p0.z + p1.z) / 2,
    );

    if (!pinchState.twoHand.active) {
      pinchState.twoHand.active = true;
      pinchState.twoHand.initDist = currentDist;
      pinchState.twoHand.initAngle = currentAngle;
      pinchState.twoHand.initRotY = marketsGroup.rotation.y;
      pinchState.twoHand.initMid.copy(currentMid);
      pinchState.twoHand.initPos.copy(marketsGroup.position);
      // Capture user's position and directions at gesture start
      const xrCam = renderer.xr.getCamera();
      xrCam.getWorldPosition(pinchState.twoHand.pivotPos);
      pinchState.twoHand.pivotPos.y = 0; // pivot around Y axis at floor level
      xrCam.getWorldDirection(pinchState.twoHand.initForward);
      pinchState.twoHand.initForward.y = 0;
      pinchState.twoHand.initForward.normalize();
      pinchState.twoHand.initRight.crossVectors(
        new THREE.Vector3(0, 1, 0),
        pinchState.twoHand.initForward,
      ).normalize();
    } else {
      const fwd = pinchState.twoHand.initForward;
      const right = pinchState.twoHand.initRight;
      const initPos = pinchState.twoHand.initPos;
      const initMid = pinchState.twoHand.initMid;

      // Forward/back — spread moves scene toward user, contract away
      const distDelta = currentDist - pinchState.twoHand.initDist;

      // Left/right — both hands shift laterally
      const midDeltaX = currentMid.x - initMid.x;
      const midDeltaZ = currentMid.z - initMid.z;
      const lateralDelta = midDeltaX * right.x + midDeltaZ * right.z;

      marketsGroup.position.x = initPos.x - fwd.x * distDelta * 8 + right.x * lateralDelta * 5;
      marketsGroup.position.z = initPos.z - fwd.z * distDelta * 8 + right.z * lateralDelta * 5;

      // Rotate around group's own origin
      const angleDelta = currentAngle - pinchState.twoHand.initAngle;
      marketsGroup.rotation.y = pinchState.twoHand.initRotY + angleDelta;

      // Translate Y — both hands moving up/down together
      const deltaY = currentMid.y - initMid.y;
      marketsGroup.position.y = initPos.y + deltaY * 5;
    }
  } else {
    pinchState.twoHand.active = false;
  }
}

// ---- Per-Frame Tick (called from main.js after tickVisualization) ------------

export function tickInteraction() {
  if (!renderer.xr.isPresenting) {
    reticleMesh.visible = false;
    return;
  }

  // Gaze-based hover
  updateGaze();

  // Boost emissive in VR to compensate for no bloom post-processing,
  // and apply hover highlight on gazed sphere
  const VR_EMISSIVE_BOOST = 1.8;
  for (const [, entry] of getMarketMeshes()) {
    const base = entry.baseEmissive || 0.4;
    if (entry.sphere._hovered) {
      entry.sphere.scale.setScalar(entry.targetRadius * HOVER_SCALE_MULT);
      entry.sphere.material.emissiveIntensity = (base + HOVER_EMISSIVE_BOOST) * VR_EMISSIVE_BOOST;
    } else {
      entry.sphere.material.emissiveIntensity = base * VR_EMISSIVE_BOOST;
    }
  }

  // Two-hand pinch zoom/rotate
  updatePinchGestures();

  // Billboard VR detail panel
  if (vrDetailGroup.visible) {
    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(_camPos);
    vrDetailGroup.lookAt(_camPos);
  }
}

export { hideHTMLDetail as hideDetail };
