import * as THREE from 'three'

export interface JellyUniforms {
  uJellyOffset: { value: THREE.Vector2 }
  uJellyVelocity: { value: THREE.Vector2 }
  uJellyTime: { value: number }
  uJellyStrength: { value: number }
}

export function createJellyUniforms(): JellyUniforms {
  return {
    uJellyOffset: { value: new THREE.Vector2(0, 0) },
    uJellyVelocity: { value: new THREE.Vector2(0, 0) },
    uJellyTime: { value: 0 },
    uJellyStrength: { value: 1.0 },
  }
}

/**
 * Shared GLSL snippet that applies spring-driven jelly deformation to any vertex.
 * The bottom of the block (y <= 0) stays anchored to the studio table,
 * while higher vertices sway, shear, tilt, and bulge elastically like real jelly.
 */
export const JELLY_VERTEX_PARS = /* glsl */ `
uniform vec2 uJellyOffset;
uniform vec2 uJellyVelocity;
uniform float uJellyTime;
uniform float uJellyStrength;

vec3 applyJellyDeformation(vec3 worldPos) {
  // Normalized height from base (y = 0) to top of block/island (y ~ 1.6..3.0)
  float h = max(0.0, worldPos.y);
  // Smooth nonlinear profile: bottom is fixed, upper portion sways significantly more
  float bendFactor = pow(clamp(h / 1.65, 0.0, 2.2), 1.35) * uJellyStrength;

  // High-frequency secondary elastic ripple traveling vertically through the jelly block
  float elasticRipple = sin(h * 3.2 - uJellyTime * 9.0) * 0.14 * length(uJellyVelocity) * uJellyStrength;
  vec2 velDir = length(uJellyVelocity) > 0.0001 ? normalize(uJellyVelocity) : vec2(0.0);

  vec2 horizontalShift = uJellyOffset * bendFactor + velDir * elasticRipple * (h * 0.45);

  // Subtle volume-preserving vertical tilt & squash when the block leans to one side
  float verticalTilt = -dot(worldPos.xz, uJellyOffset) * 0.16 * clamp(h / 1.5, 0.0, 1.4) * uJellyStrength;

  worldPos.x += horizontalShift.x;
  worldPos.z += horizontalShift.y;
  worldPos.y += verticalTilt;
  return worldPos;
}
`

/**
 * Injects jelly vertex deformation into any standard Three.js material (MeshStandardMaterial,
 * MeshPhysicalMaterial, MeshTransmissionMaterial) via onBeforeCompile.
 */
export function injectJellyIntoMaterial(
  material: THREE.Material,
  jellyUniforms: JellyUniforms,
  extraCustomKey = ''
) {
  material.customProgramCacheKey = () => `jelly-mat-${material.type}-${extraCustomKey}`
  const prevBeforeCompile = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    if (prevBeforeCompile) prevBeforeCompile(shader, renderer)
    shader.uniforms.uJellyOffset = jellyUniforms.uJellyOffset
    shader.uniforms.uJellyVelocity = jellyUniforms.uJellyVelocity
    shader.uniforms.uJellyTime = jellyUniforms.uJellyTime
    shader.uniforms.uJellyStrength = jellyUniforms.uJellyStrength

    shader.vertexShader = `${JELLY_VERTEX_PARS}\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 jellyWorldPos = modelMatrix * mvPosition;
      jellyWorldPos.xyz = applyJellyDeformation(jellyWorldPos.xyz);
      mvPosition = viewMatrix * jellyWorldPos;
      gl_Position = projectionMatrix * mvPosition;
      `
    )
  }
}
