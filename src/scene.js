/**
 * Scene Setup
 *
 * Three.js scene with WebXR support, bloom post-processing,
 * orbit controls, and a dark space aesthetic.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---- Renderer ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;

const container = document.getElementById('canvas-container');
container.appendChild(renderer.domElement);

// VR button — request hand-tracking as optional so it degrades on non-hand devices
const sessionInit = { optionalFeatures: ['hand-tracking'] };
const vrButton = VRButton.createButton(renderer, sessionInit);
document.body.appendChild(vrButton);

// ---- Scene ------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);
scene.fog = new THREE.FogExp2(0x050510, 0.018);

// ---- Camera -----------------------------------------------------------------

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  300,
);
camera.position.set(0, 6, 24);
camera.lookAt(0, 3, 0);

// ---- Controls ---------------------------------------------------------------

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 3, -4);
controls.minDistance = 3;
controls.maxDistance = 80;
controls.maxPolarAngle = Math.PI * 0.85;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;

// Stop auto-rotate when user interacts
renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; });

// ---- Lighting ---------------------------------------------------------------

// Hemisphere light for ambient fill (sky/ground colors)
const hemiLight = new THREE.HemisphereLight(0x4060a0, 0x101020, 0.4);
scene.add(hemiLight);

// Key light — slightly warm
const keyLight = new THREE.DirectionalLight(0xffeedd, 0.8);
keyLight.position.set(15, 20, 10);
scene.add(keyLight);

// Fill light — cool blue from opposite side
const fillLight = new THREE.DirectionalLight(0x4488ff, 0.4);
fillLight.position.set(-10, 10, -15);
scene.add(fillLight);

// Point lights for local highlights
const pointLight1 = new THREE.PointLight(0x6080ff, 1.5, 60);
pointLight1.position.set(12, 18, 8);
scene.add(pointLight1);

const pointLight2 = new THREE.PointLight(0xff6040, 0.8, 50);
pointLight2.position.set(-12, 10, -12);
scene.add(pointLight2);

const pointLight3 = new THREE.PointLight(0x40ffaa, 0.5, 40);
pointLight3.position.set(0, 5, -20);
scene.add(pointLight3);

// ---- Grid floor -------------------------------------------------------------

const grid = new THREE.GridHelper(100, 100, 0x151530, 0x151530);
grid.material.opacity = 0.15;
grid.material.transparent = true;
grid.position.y = -0.5;
scene.add(grid);

// ---- Starfield background ----------------------------------------------------

const starCount = 600;
const starGeo = new THREE.BufferGeometry();
const starPositions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  starPositions[i * 3] = (Math.random() - 0.5) * 200;
  starPositions[i * 3 + 1] = Math.random() * 80 + 5;
  starPositions[i * 3 + 2] = (Math.random() - 0.5) * 200;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMat = new THREE.PointsMaterial({
  color: 0x8899cc,
  size: 0.12,
  transparent: true,
  opacity: 0.6,
  sizeAttenuation: true,
});
scene.add(new THREE.Points(starGeo, starMat));

// ---- Bloom post-processing --------------------------------------------------

const renderPass = new RenderPass(scene, camera);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.0,   // strength
  0.5,   // radius
  0.7,   // threshold
);

const outputPass = new OutputPass();

const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// ---- Resize handler ---------------------------------------------------------

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ---- XR Controllers (indices 0-3) -------------------------------------------
// 0-1: standard controllers / hand sources
// 2-3: Vision Pro transient pointers (gaze + pinch)

const controllerModelFactory = new XRControllerModelFactory();
const controllers = [];

for (let i = 0; i < 4; i++) {
  const controller = renderer.xr.getController(i);
  scene.add(controller);
  controllers.push(controller);
}

// Controller grips with models (standard controllers only)
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  scene.add(grip);
}

// ---- XR Hands ---------------------------------------------------------------

const handModelFactory = new XRHandModelFactory();
const hands = [];

for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i);
  hand.add(handModelFactory.createHandModel(hand));
  scene.add(hand);
  hands.push(hand);
}

export { scene, camera, renderer, composer, controls, controllers, hands };
