/**
 * Frozen Aperture — Custom Glossy Black-Liquid GLSL Shader for Central Aperture (#17)
 * Lightweight Fresnel + animated surface distortion shader whose uTime uniform
 * advances STRICTLY when the vortex's temporalState === 'active' (100% frozen when held).
 */

import * as THREE from 'three';

const VERTEX_SHADER = `
uniform float uTime;
uniform float uActive;
varying vec3 vNormalWorld;
varying vec3 vViewDir;
varying vec3 vLocalPos;

void main() {
  vLocalPos = position;
  // Subtle liquid ripple displacement strictly gated by uActive & uTime
  float wave = sin(position.x * 5.0 + uTime * 2.6) * cos(position.y * 5.0 - uTime * 2.1) * sin(position.z * 5.0 + uTime * 1.8);
  vec3 displaced = position + normal * (wave * 0.032 * uActive);
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  vNormalWorld = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
uniform float uTime;
uniform float uActive;
uniform vec3 uRimColor;
uniform vec3 uAccentColor;
varying vec3 vNormalWorld;
varying vec3 vViewDir;
varying vec3 vLocalPos;

void main() {
  vec3 N = normalize(vNormalWorld);
  vec3 V = normalize(vViewDir);
  float ndotv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = pow(1.0 - ndotv, 3.2);

  // Specular glossy black-liquid highlight
  vec3 L = normalize(vec3(0.45, 0.78, 0.55));
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 96.0);

  // Radial liquid caustics pattern (strictly frozen when uTime is frozen)
  float swirl = 0.5 + 0.5 * sin(atan(vLocalPos.y, vLocalPos.x) * 4.0 + length(vLocalPos.xy) * 9.0 - uTime * 3.0);
  vec3 obsidian = vec3(0.012, 0.018, 0.035);
  vec3 rim = mix(uRimColor, uAccentColor, swirl * 0.65) * fresnel * (0.75 + 0.65 * uActive);
  vec3 color = obsidian + rim + vec3(0.75, 0.92, 1.0) * spec * 0.85;

  gl_FragColor = vec4(color, 1.0);
}
`;

export function createBlackLiquidVortexMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uActive: { value: 0 },
      uRimColor: { value: new THREE.Color(0x38bdf8) },
      uAccentColor: { value: new THREE.Color(0x6366f1) },
    },
  });
}
