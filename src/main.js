/**
 * Main entry point
 *
 * Wires together scene, visualization, interaction, and data service.
 * Runs the animation loop.
 */

import { scene, camera, renderer, composer, controls } from './scene.js';
import { updateMarkets, triggerVolumeSpike, tickVisualization } from './visualization.js';
import { tickInteraction } from './interaction.js';
import { getPoller } from './data/polymarket.js';

// ---- HUD elements -----------------------------------------------------------

const hudMarkets = document.getElementById('hud-markets');
const hudUpdate = document.getElementById('hud-update');
const hudStatus = document.getElementById('hud-status');

// ---- Data service -----------------------------------------------------------

const poller = getPoller({ interval: 120_000, topLimit: 50, nearLimit: 20 });

let allEvents = [];

function mergeEvents(top, near) {
  const map = new Map();
  for (const e of top) map.set(e.id, e);
  for (const e of near) {
    if (!map.has(e.id)) map.set(e.id, e);
  }
  return Array.from(map.values());
}

poller.addEventListener('update', (e) => {
  const { topMarkets, nearResolution } = e.detail;
  allEvents = mergeEvents(topMarkets, nearResolution);
  updateMarkets(allEvents);

  // Update HUD
  hudMarkets.textContent = `Markets: ${allEvents.length}`;
  hudUpdate.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
  hudStatus.textContent = 'Status: live';
});

poller.addEventListener('volumeSpike', (e) => {
  triggerVolumeSpike(e.detail.event.id);
});

poller.addEventListener('priceSwing', () => {
  // Price swings are reflected in color changes automatically on next update
});

poller.addEventListener('error', (e) => {
  console.error('Poller error:', e.detail);
  hudStatus.textContent = 'Status: error (retrying...)';
});

// Start polling
poller.start();

// ---- Animation loop ---------------------------------------------------------

function animate(time) {
  controls.update();
  tickVisualization(time);
  tickInteraction();

  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  } else {
    composer.render();
  }
}

renderer.setAnimationLoop(animate);
