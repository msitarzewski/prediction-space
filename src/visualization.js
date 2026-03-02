/**
 * Visualization
 *
 * Transforms market data into 3D objects: spheres sized by volume,
 * colored by leading outcome price, arranged by category in 3D space.
 */

import * as THREE from 'three';
import { scene, camera } from './scene.js';

// ---- Constants --------------------------------------------------------------

const MIN_RADIUS = 0.2;
const MAX_RADIUS = 1.2;
const LERP_SPEED = 0.04;
const LABEL_MAX_CHARS = 25;
const NEAR_RESOLUTION_HOURS = 48;

// Labels only visible within this distance from camera
const LABEL_VISIBLE_DISTANCE = 15;
const LABEL_FADE_START = 10;

// Category zone positions — spread out in 3D (x, y, z)
const ZONE_POSITIONS = {
  politics:    { x: -8,  y: 4,  z: -4 },
  crypto:      { x: 8,   y: 5,  z: -6 },
  sports:      { x: -12, y: 2,  z: -12 },
  tech:        { x: 12,  y: 6,  z: -10 },
  science:     { x: 0,   y: 8,  z: -14 },
  culture:     { x: -5,  y: 3,  z: -16 },
  finance:     { x: 6,   y: 3,  z: -12 },
  pop_culture: { x: -10, y: 5,  z: -8 },
  other:       { x: 0,   y: 4,  z: 6 },
};
const DEFAULT_ZONE = { x: 0, y: 4, z: 6 };
const ZONE_SPREAD = 5;

// ---- State ------------------------------------------------------------------

const marketMeshes = new Map();   // eventId -> { group, sphere, label, targetPos, spikeTime }
const volumeSpikeIds = new Set(); // eventIds currently pulsing
const geometry = new THREE.IcosahedronGeometry(1, 4); // detail level 4 for smoother spheres

// Container group so we can manage all market objects together
const marketsGroup = new THREE.Group();
scene.add(marketsGroup);


// ---- Helpers ----------------------------------------------------------------

function getLeadingPrice(outcomes) {
  if (!outcomes || outcomes.length === 0) return 0.5;
  let best = outcomes[0];
  for (const o of outcomes) {
    if (o.price != null && (best.price == null || o.price > best.price)) best = o;
  }
  return best.price ?? 0.5;
}

/**
 * Map probability to hue, activity to brightness/saturation.
 * @param {number} price    - leading outcome probability 0-1
 * @param {number} activity - 0 (quiet) to 1 (hot) normalized activity score
 */
function priceToColor(price, activity = 0.5) {
  const hue = Math.min(Math.max(price, 0), 1) * 0.33;
  const saturation = 0.35 + activity * 0.55;  // 0.35 (muted) to 0.90 (vivid)
  const lightness = 0.22 + activity * 0.38;   // 0.22 (dark) to 0.60 (bright)
  const color = new THREE.Color();
  color.setHSL(hue, saturation, lightness);
  return color;
}

function volumeToRadius(volume, minVol, maxVol) {
  if (maxVol <= minVol) return (MIN_RADIUS + MAX_RADIUS) / 2;
  const logMin = Math.log1p(minVol);
  const logMax = Math.log1p(maxVol);
  const logVol = Math.log1p(volume);
  const t = (logVol - logMin) / (logMax - logMin);
  return MIN_RADIUS + t * (MAX_RADIUS - MIN_RADIUS);
}

/**
 * Compute activity score 0-1 for a market.
 * Combines: volume24hr relative to group + volume ratio (24h vs total).
 */
function computeActivity(event, minVol24, maxVol24) {
  // How hot is this market's 24h volume relative to others?
  const vol24 = event.volume24hr || 0;
  const logMin = Math.log1p(minVol24);
  const logMax = Math.log1p(maxVol24);
  const volScore = logMax > logMin
    ? (Math.log1p(vol24) - logMin) / (logMax - logMin)
    : 0.5;

  // What fraction of total volume happened in the last 24h? (velocity)
  const total = event.totalVolume || 1;
  const velocityRatio = Math.min(vol24 / total, 1);
  const velocityScore = Math.sqrt(velocityRatio); // sqrt to spread the range

  // Blend: 60% relative volume, 40% velocity
  return Math.min(volScore * 0.6 + velocityScore * 0.4, 1);
}

function classifyCategory(category) {
  if (!category) return 'other';
  const lower = category.toLowerCase();
  for (const key of Object.keys(ZONE_POSITIONS)) {
    if (lower.includes(key)) return key;
  }
  if (lower.includes('politi') || lower.includes('election') || lower.includes('trump') || lower.includes('biden')) return 'politics';
  if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('eth')) return 'crypto';
  if (lower.includes('sport') || lower.includes('nba') || lower.includes('nfl') || lower.includes('soccer') || lower.includes('mls') || lower.includes('mlb')) return 'sports';
  if (lower.includes('tech') || lower.includes('ai') || lower.includes('apple') || lower.includes('google')) return 'tech';
  return 'other';
}

function computeTargetPosition(event, indexInZone) {
  const cat = classifyCategory(event.category);
  const zone = ZONE_POSITIONS[cat] || DEFAULT_ZONE;

  // 3D spiral arrangement within zone
  const goldenAngle = 2.399963; // golden angle in radians
  const angle = indexInZone * goldenAngle;
  const r = 1.2 + Math.sqrt(indexInZone) * 1.1;
  const elevation = ((indexInZone % 5) - 2) * 1.5; // vary Y within zone

  let x = zone.x + Math.cos(angle) * r;
  let z = zone.z + Math.sin(angle) * r;
  let y = zone.y + elevation + (Math.sin(indexInZone * 0.7) * ZONE_SPREAD * 0.3);

  // Near-resolution markets drift toward the floor
  if (event.endDate) {
    const hoursLeft = (new Date(event.endDate) - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft > 0 && hoursLeft < NEAR_RESOLUTION_HOURS) {
      const proximity = 1 - hoursLeft / NEAR_RESOLUTION_HOURS;
      y = y * (1 - proximity) + 0.5 * proximity;
    }
  }

  return new THREE.Vector3(x, y, z);
}

function createLabel(text) {
  const truncated = text.length > LABEL_MAX_CHARS
    ? text.slice(0, LABEL_MAX_CHARS - 1) + '\u2026'
    : text;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 48;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.font = '500 24px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(200, 210, 240, 0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncated, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0, // start invisible, fade in based on distance
  });
  const sprite = new THREE.Sprite(mat);
  // Much smaller labels
  sprite.scale.set(2.5, 0.25, 1);
  return sprite;
}

// ---- Public API -------------------------------------------------------------

/**
 * Update the 3D visualization with fresh market data.
 * Diffs against existing objects: adds new, updates existing, removes stale.
 */
export function updateMarkets(events) {
  const currentIds = new Set();

  // Compute volume range for radius and activity mapping
  const volumes = events.map((e) => e.volume24hr || 0);
  const minVol = Math.min(...volumes, 0);
  const maxVol = Math.max(...volumes, 1);

  // Track per-category index for layout
  const categoryCounters = {};

  for (const event of events) {
    currentIds.add(event.id);
    const cat = classifyCategory(event.category);
    if (!(cat in categoryCounters)) categoryCounters[cat] = 0;
    const indexInZone = categoryCounters[cat]++;

    const price = getLeadingPrice(event.outcomes);
    const activity = computeActivity(event, minVol, maxVol);
    const color = priceToColor(price, activity);
    const radius = volumeToRadius(event.volume24hr || 0, minVol, maxVol);
    const targetPos = computeTargetPosition(event, indexInZone);

    const emissiveIntensity = 0.2 + activity * 0.5; // quiet=0.2, hot=0.7

    if (marketMeshes.has(event.id)) {
      // Update existing
      const entry = marketMeshes.get(event.id);
      entry.targetPos.copy(targetPos);
      entry.sphere.material.color.copy(color);
      entry.sphere.material.emissive.copy(color);
      entry.sphere.material.emissiveIntensity = emissiveIntensity;
      entry.targetRadius = radius;
      entry.baseEmissive = emissiveIntensity;
      entry.event = event;
    } else {
      // Create new sphere with glassy material
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity,
        metalness: 0.6,
        roughness: 0.15,
        transparent: true,
        opacity: 0,
        envMapIntensity: 1.0,
      });

      const sphere = new THREE.Mesh(geometry, mat);
      sphere.scale.setScalar(radius);

      const label = createLabel(event.title);
      label.position.y = radius + 0.5;

      const group = new THREE.Group();
      group.position.copy(targetPos);
      group.position.y += 3; // start above for drop-in animation
      group.add(sphere);
      group.add(label);

      marketsGroup.add(group);

      const entry = {
        group,
        sphere,
        label,
        targetPos,
        targetRadius: radius,
        baseEmissive: emissiveIntensity,
        spikeTime: -1,
        event,
      };
      sphere.userData.eventId = event.id;
      marketMeshes.set(event.id, entry);
    }
  }

  // Remove markets no longer in data
  for (const [id, entry] of marketMeshes) {
    if (!currentIds.has(id)) {
      marketsGroup.remove(entry.group);
      entry.sphere.geometry = undefined; // shared geo, don't dispose
      entry.sphere.material.dispose();
      if (entry.label.material.map) entry.label.material.map.dispose();
      entry.label.material.dispose();
      marketMeshes.delete(id);
      volumeSpikeIds.delete(id);
    }
  }
}

/**
 * Flag a market for the volume-spike pulsing animation.
 */
export function triggerVolumeSpike(eventId) {
  const entry = marketMeshes.get(eventId);
  if (entry) {
    entry.spikeTime = performance.now();
    volumeSpikeIds.add(eventId);
  }
}

// Temp vector for distance calculations
const _tempVec = new THREE.Vector3();

/**
 * Per-frame animation tick. Call from the main loop.
 */
export function tickVisualization(time) {
  const camPos = camera.position;

  for (const [id, entry] of marketMeshes) {
    const { group, sphere, label, targetPos, targetRadius } = entry;

    // Smooth position lerp
    group.position.lerp(targetPos, LERP_SPEED);

    // Smooth radius lerp
    const currentScale = sphere.scale.x;
    const newScale = currentScale + (targetRadius - currentScale) * LERP_SPEED;
    sphere.scale.setScalar(newScale);

    // Label follows sphere radius
    label.position.y = newScale + 0.5;

    // Fade sphere in
    if (sphere.material.opacity < 1) {
      sphere.material.opacity = Math.min(sphere.material.opacity + 0.02, 1);
    }

    // Distance-based label visibility
    _tempVec.copy(group.position);
    const dist = camPos.distanceTo(_tempVec);
    if (dist < LABEL_FADE_START) {
      label.material.opacity = 1;
    } else if (dist < LABEL_VISIBLE_DISTANCE) {
      label.material.opacity = 1 - (dist - LABEL_FADE_START) / (LABEL_VISIBLE_DISTANCE - LABEL_FADE_START);
    } else {
      label.material.opacity = 0;
    }

    // Volume spike pulsing (5 seconds)
    if (entry.spikeTime > 0) {
      const elapsed = time - entry.spikeTime;
      if (elapsed < 5000) {
        const pulse = 1 + 0.2 * Math.sin(elapsed * 0.008);
        sphere.scale.setScalar(newScale * pulse);
        sphere.material.emissiveIntensity = (entry.baseEmissive || 0.4) + 0.5 * Math.abs(Math.sin(elapsed * 0.006));
      } else {
        entry.spikeTime = -1;
        volumeSpikeIds.delete(id);
        sphere.material.emissiveIntensity = entry.baseEmissive || 0.4;
      }
    }

    // Gentle idle bob and rotation
    sphere.rotation.y += 0.003;
    sphere.rotation.x += 0.001;
    group.position.y += Math.sin(time * 0.001 + group.position.x) * 0.0008;
  }
}

/**
 * Returns the Map of market meshes keyed by event ID.
 */
export function getMarketMeshes() {
  return marketMeshes;
}

/**
 * Returns the container group holding all market objects.
 */
export function getMarketsGroup() {
  return marketsGroup;
}
