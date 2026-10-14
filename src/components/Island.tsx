import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import {
  BLOCK_HALF_SIZE,
  BLOCK_CORNER_RADIUS,
  BASE_SAND_HEIGHT,
  mapSquareToRoundedBox,
  sampleTerrain,
} from '../utils/dioramaData'
import { JELLY_VERTEX_PARS, JellyUniforms } from '../utils/jellyShader'

export interface IslandProps {
  waterLevel: number
  waterColor: string
  sunDirection: THREE.Vector3
  jellyUniforms: JellyUniforms
  segments?: number
}

const ISLAND_VERTEX_SHADER = /* glsl */ `
${JELLY_VERTEX_PARS}

attribute vec3 aTerrainMeta;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec3 vWorldNormal;
varying vec3 vTerrainMeta;

void main() {
  vLocalPos = position;
  vTerrainMeta = aTerrainMeta;

  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);

  // Apply shared spring jelly deformation
  worldPosition.xyz = applyJellyDeformation(worldPosition.xyz);

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

const ISLAND_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uWaterLevel;
uniform vec3 uWaterColor;
uniform vec3 uSunDirection;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec3 vWorldNormal;
varying vec3 vTerrainMeta;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
      mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
      mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x),
      f.y
    ),
    f.z
  );
}

float fbm3(vec3 p) {
  float v = 0.65 * noise3(p);
  p = p * 2.07 + vec3(13.1, 7.7, 19.3);
  v += 0.35 * noise3(p);
  return v;
}

void main() {
  float beachMask = vTerrainMeta.x;
  float cliffCoreMask = vTerrainMeta.y;
  float boxSdf = vTerrainMeta.z;

  // Discard seabed pixels outside the island & beach so Seabed.tsx renders the ocean floor
  if (vLocalPos.y < uWaterLevel - 0.16 && cliffCoreMask < 0.03 && beachMask < 0.05) {
    discard;
  }

  vec3 baseNormal = normalize(vWorldNormal);
  float slope = 1.0 - clamp(abs(baseNormal.y), 0.0, 1.0);

  // 1. 3D Craggy Limestone Facets + Vertical Flutes + Irregular Sedimentary Bedding (only 4 noise3 calls total!)
  float nMacro = fbm3(vLocalPos * 2.2);
  float nMid = fbm3(vLocalPos * 6.5 + 4.2);

  // Vertical erosion chutes / ribs typical of Kelingking coastal limestone cliffs
  float verticalRibs = clamp(
    0.5 + 0.32 * sin(vLocalPos.x * 13.5 + vLocalPos.z * 11.2 + nMacro * 4.5) +
    0.22 * cos(vLocalPos.x * 23.0 - vLocalPos.z * 19.0 + nMid * 3.8),
    0.0,
    1.0
  );
  // Fine multi-frequency sedimentary bedding warped by rock structure
  float warpedY = vLocalPos.y + (nMacro - 0.5) * 0.28 + (verticalRibs - 0.5) * 0.16;
  float strataShelf =
    sin(warpedY * 28.0) * 0.45 +
    cos(warpedY * 58.0 + nMid * 3.0) * 0.35 +
    sin(warpedY * 12.0) * 0.20;
  float diagonalFracture = clamp(
    0.5 + 0.35 * sin((vLocalPos.x + vLocalPos.z) * 10.5 + vLocalPos.y * 14.0 + nMid * 4.2) +
    (nMacro - 0.5) * 0.4,
    0.0,
    1.0
  );

  float rockHeightField =
    verticalRibs * 0.46 +
    nMid * 0.36 +
    strataShelf * 0.14 +
    diagonalFracture * 0.26;

  // Perturb surface normal on cliff faces using screen-space derivatives for sharp 3D rock facets
  vec3 dpdx = dFdx(vWorldPos);
  vec3 dpdy = dFdy(vWorldPos);
  float dhdx = dFdx(rockHeightField);
  float dhdy = dFdy(rockHeightField);
  float bumpStrength = smoothstep(0.18, 0.65, slope) * (1.0 - beachMask * 0.9) * 6.2;
  vec3 N = normalize(baseNormal - (dpdx * dhdx + dpdy * dhdy) * bumpStrength);

  // 2. Limestone Cliff Palette (warm buff/ochre rock + dark charcoal vertical weathering + terracotta crevices)
  vec3 limestoneCream = vec3(0.84, 0.75, 0.62);
  vec3 warmOchre = vec3(0.66, 0.52, 0.38);
  vec3 terracottaRust = vec3(0.54, 0.39, 0.27);
  vec3 darkCharcoalWeathered = vec3(0.22, 0.20, 0.18);
  vec3 creviceShadow = vec3(0.14, 0.12, 0.10);

  vec3 rockColor = mix(warmOchre, limestoneCream, smoothstep(-0.45, 0.45, strataShelf * 0.65 + (nMid - 0.5) * 0.7));
  rockColor = mix(rockColor, terracottaRust, smoothstep(0.46, 0.76, nMacro));

  // Vertical dark water-streaked limestone ribs & overhangs
  float darkStreakMask = smoothstep(0.46, 0.74, verticalRibs * 0.65 + (1.0 - diagonalFracture) * 0.45) * smoothstep(0.35, 0.80, slope);
  rockColor = mix(rockColor, darkCharcoalWeathered, darkStreakMask * 0.72);

  // Deep craggy fracture crevices
  float fractureMask = smoothstep(0.32, 0.14, diagonalFracture * 0.6 + nMid * 0.4);
  rockColor = mix(rockColor, creviceShadow, fractureMask * 0.65);

  // Sea-cave undercut dark shadow along the base of the cliff above the beach/water
  float caveUndercut =
    smoothstep(uWaterLevel - 0.05, uWaterLevel + 0.16, vLocalPos.y) *
    smoothstep(uWaterLevel + 0.62, uWaterLevel + 0.20, vLocalPos.y) *
    smoothstep(0.45, 0.85, slope);
  rockColor *= 1.0 - caveUndercut * 0.52;

  // 3. Summit Forest Soil & Moss Transition on gentler upper slopes
  vec3 mossGreen = vec3(0.16, 0.28, 0.09);
  vec3 darkSoil = vec3(0.24, 0.19, 0.13);
  float topMossMask =
    smoothstep(1.95, 2.55, vLocalPos.y) *
    smoothstep(0.76, 0.22, slope) *
    (1.0 - beachMask);
  vec3 summitSurface = mix(darkSoil, mossGreen, smoothstep(0.30, 0.65, nMid));
  vec3 cliffAndTopColor = mix(rockColor, summitSurface, topMossMask);

  // Clean architectural cross-section cut on the back-left outer resin block boundary
  float outerCutMask = smoothstep(-0.08, -0.005, boxSdf);
  vec3 cutStoneColor = mix(vec3(0.66, 0.56, 0.44), vec3(0.46, 0.38, 0.29), smoothstep(0.3, 0.7, nMacro));
  cliffAndTopColor = mix(cliffAndTopColor, cutStoneColor, outerCutMask * 0.45);

  // 4. Crescent Sandy Beach ("一弯沙滩") — warm golden-ivory sand that never blows out to white
  float sandGrain = fract(sin(dot(vLocalPos.xz, vec2(127.1, 311.7))) * 43758.5453);
  float sandRipple = sin(vLocalPos.x * 18.0 + vLocalPos.z * 16.0 + nMacro * 4.0) * 0.5 + 0.5;
  vec3 sandDry = vec3(0.84, 0.75, 0.60) + (sandGrain - 0.5) * 0.03 + (sandRipple - 0.5) * 0.025;
  vec3 sandWet = vec3(0.64, 0.53, 0.39);

  float heightAboveWater = vLocalPos.y - uWaterLevel;
  float wetZone = 1.0 - smoothstep(-0.04, 0.16, heightAboveWater);
  vec3 sandColor = mix(sandDry, sandWet, wetZone * 0.85);

  // Soft ambient occlusion at the base of the cliff where sand meets rock
  float cliffBaseAO = smoothstep(0.15, 0.55, cliffCoreMask) * beachMask;
  sandColor *= 1.0 - cliffBaseAO * 0.22;

  float effectiveBeach = clamp(
    beachMask * smoothstep(0.68, 0.18, slope) * smoothstep(2.05, 1.68, vLocalPos.y),
    0.0,
    1.0
  );
  vec3 surfaceColor = mix(cliffAndTopColor, sandColor, effectiveBeach);

  // 5. Studio Sun & Sky Lighting
  vec3 L = normalize(uSunDirection);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(L + V);

  float ndl = max(0.0, dot(N, L));
  float sunDiffuse = 0.28 + 0.68 * ndl;
  float skyFill = 0.14 * (0.5 + 0.5 * N.y);

  // Wet shoreline sheen on wet sand and wave-splashed lower cliff
  float wetSheenMask = wetZone * smoothstep(-0.15, 0.08, heightAboveWater);
  float wetSpec = pow(max(0.0, dot(N, H)), 48.0) * wetSheenMask * 0.28;

  vec3 litColor = surfaceColor * (sunDiffuse + skyFill) + vec3(1.0, 0.97, 0.90) * wetSpec;

  // 6. Underwater Turquoise Depth Absorption for the submerged lower cliff & beach slope
  if (heightAboveWater < 0.0) {
    float subDepth = clamp(-heightAboveWater / 1.05, 0.0, 1.0);
    vec3 shallowTint = mix(vec3(0.45, 0.94, 0.89), uWaterColor, 0.42);
    vec3 deepTint = uWaterColor * vec3(0.12, 0.48, 0.62);
    vec3 waterColumnColor = mix(shallowTint, deepTint, subDepth);
    litColor = mix(litColor, waterColumnColor, clamp(subDepth * 0.78 + 0.15, 0.0, 0.88));
  }

  gl_FragColor = vec4(litColor, 1.0);
}
`

export function Island({
  waterLevel,
  waterColor,
  sunDirection,
  jellyUniforms,
  segments = 160,
}: IslandProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1, segments, segments)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position as THREE.BufferAttribute
    const metaArray = new Float32Array(pos.count * 3)

    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) * 2.0
      const v = pos.getZ(i) * 2.0
      const [rx, rz] = mapSquareToRoundedBox(
        u,
        v,
        BLOCK_HALF_SIZE - 0.015,
        BLOCK_CORNER_RADIUS - 0.015
      )

      const s = sampleTerrain(rx, rz)
      // Anchor the outer boundary vertices down to BASE_SAND_HEIGHT so the back/left cliff walls
      // form a solid flush architectural cross-section down to the sandy base
      const isOuterEdge =
        Math.abs(u) > 0.985 || Math.abs(v) > 0.985
      const y = isOuterEdge ? BASE_SAND_HEIGHT : s.height

      pos.setXYZ(i, rx, y, rz)

      metaArray[i * 3 + 0] = s.beachMask
      metaArray[i * 3 + 1] = s.cliffCoreMask
      metaArray[i * 3 + 2] = isOuterEdge ? 0.0 : s.boxSdf
    }

    geo.setAttribute('aTerrainMeta', new THREE.BufferAttribute(metaArray, 3))
    geo.computeVertexNormals()
    return geo
  }, [segments])

  const uniforms = useMemo(
    () => ({
      uWaterLevel: { value: waterLevel },
      uWaterColor: { value: new THREE.Color(waterColor) },
      uSunDirection: { value: sunDirection.clone() },
      uJellyOffset: jellyUniforms.uJellyOffset,
      uJellyVelocity: jellyUniforms.uJellyVelocity,
      uJellyTime: jellyUniforms.uJellyTime,
      uJellyStrength: jellyUniforms.uJellyStrength,
    }),
    [jellyUniforms]
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  useFrame(() => {
    if (matRef.current) {
      matRef.current.uniforms.uWaterLevel.value = waterLevel
      matRef.current.uniforms.uWaterColor.value.set(waterColor)
      matRef.current.uniforms.uSunDirection.value.copy(sunDirection)
    }
  })

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <shaderMaterial
        ref={matRef}
        vertexShader={ISLAND_VERTEX_SHADER}
        fragmentShader={ISLAND_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </mesh>
  )
}
