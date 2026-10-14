import { useEffect, useMemo, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

export interface WaterSimulationOptions {
  resolution?: number
  rippleStrength: number
  waveHeight: number
  waterLevel: number
  terrainMap: THREE.DataTexture
}

export interface WaterSimulationResult {
  getHeightfieldTexture: () => THREE.Texture
  injectPointerUv: (uv: THREE.Vector2, velocityBoost?: number) => void
  triggerSplash: (uv: THREE.Vector2, strength?: number) => void
}

const SIMULATION_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const SIMULATION_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uPrevState;
uniform sampler2D uTerrainMap;
uniform vec2 uTexelSize;
uniform vec2 uDropCenter;
uniform vec2 uPrevDropCenter;
uniform float uDropRadius;
uniform float uDropStrength;
uniform float uDamping;
uniform float uTime;
uniform float uIdleWaveStrength;
uniform float uWaterLevel;

varying vec2 vUv;

// Distance from point p to line segment a-b for smooth continuous mouse wakes
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec4 terrain = texture2D(uTerrainMap, vUv);
  float obstacleH = terrain.g;
  float boxSdf = terrain.a;

  // Dampen inside solid island above water level or outside the rounded resin block
  if (obstacleH > uWaterLevel + 0.04 || boxSdf > 0.02) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  vec4 cur = texture2D(uPrevState, vUv);
  float h = cur.r;
  float prevH = cur.g;

  float hL = texture2D(uPrevState, vUv - vec2(uTexelSize.x, 0.0)).r;
  float hR = texture2D(uPrevState, vUv + vec2(uTexelSize.x, 0.0)).r;
  float hD = texture2D(uPrevState, vUv - vec2(0.0, uTexelSize.y)).r;
  float hU = texture2D(uPrevState, vUv + vec2(0.0, uTexelSize.y)).r;

  float avgNeighbors = 0.25 * (hL + hR + hD + hU);

  // 2D Wave equation propagation with jelly-like cohesive tension
  float vel = (h - prevH) * uDamping;
  float nextH = h + vel + (avgNeighbors - h) * 0.46;

  // Continuous pointer wake injection along segment [uPrevDropCenter, uDropCenter]
  if (uDropStrength > 0.0001 && uDropCenter.x >= 0.0) {
    float d = sdSegment(vUv, uPrevDropCenter, uDropCenter);
    if (d < uDropRadius) {
      float drop = 1.0 - smoothstep(0.0, uDropRadius, d);
      // Cosine-bell wave impulse for authentic circular capillary & gravity ripples
      float ring = cos(drop * 3.14159265 * 0.5);
      nextH += (drop * drop - ring * 0.15) * uDropStrength;
    }
  }

  // Subtle idle natural wave excitation in open water so the surface is always alive
  float depth = max(0.0, uWaterLevel - obstacleH);
  float openWaterMask = smoothstep(0.02, 0.35, depth) * smoothstep(0.0, -0.12, boxSdf);

  float wave1 = sin(vUv.x * 18.0 + vUv.y * 12.0 - uTime * 1.85) *
                cos(vUv.x * 11.0 - vUv.y * 16.0 + uTime * 1.35);
  float wave2 = sin(vUv.x * 29.0 - vUv.y * 22.0 + uTime * 2.45) * 0.5;
  float ambientForce = (wave1 + wave2) * 0.00065 * uIdleWaveStrength * openWaterMask;

  // Gentle shoreline lapping surge pushing toward the beach
  float shoreZone = smoothstep(0.45, 0.08, depth) * smoothstep(0.0, 0.06, depth);
  float shorePulse = sin(uTime * 2.1 - depth * 18.0) * 0.0009 * uIdleWaveStrength * shoreZone;

  nextH += ambientForce + shorePulse;

  // Soft clamping to prevent numerical blowup while keeping bouncy jelly peaks
  nextH = clamp(nextH, -0.35, 0.35);

  // Compute central-difference surface slope (gradX, gradZ)
  float gradX = (hR - hL) * 0.5;
  float gradZ = (hU - hD) * 0.5;

  gl_FragColor = vec4(nextH, h, gradX, gradZ);
}
`

export function useWaterSimulation({
  resolution = 256,
  rippleStrength,
  waveHeight,
  waterLevel,
  terrainMap,
}: WaterSimulationOptions): WaterSimulationResult {
  const { gl } = useThree()

  // Create ping-pong WebGLRenderTargets
  const targets = useMemo(() => {
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    }
    return [
      new THREE.WebGLRenderTarget(resolution, resolution, opts),
      new THREE.WebGLRenderTarget(resolution, resolution, opts),
    ]
  }, [resolution])

  const pingPongIndex = useRef(0)
  const pointerState = useRef({
    active: false,
    uv: new THREE.Vector2(-1, -1),
    prevUv: new THREE.Vector2(-1, -1),
    strength: 0,
    radius: 0.038,
  })

  // Offscreen full-screen quad scene + camera for GPGPU simulation step
  const simScene = useMemo(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const material = new THREE.ShaderMaterial({
      vertexShader: SIMULATION_VERTEX_SHADER,
      fragmentShader: SIMULATION_FRAGMENT_SHADER,
      uniforms: {
        uPrevState: { value: null },
        uTerrainMap: { value: terrainMap },
        uTexelSize: { value: new THREE.Vector2(1 / resolution, 1 / resolution) },
        uDropCenter: { value: new THREE.Vector2(-1, -1) },
        uPrevDropCenter: { value: new THREE.Vector2(-1, -1) },
        uDropRadius: { value: 0.038 },
        uDropStrength: { value: 0.0 },
        uDamping: { value: 0.982 },
        uTime: { value: 0.0 },
        uIdleWaveStrength: { value: 1.0 },
        uWaterLevel: { value: waterLevel },
      },
      depthTest: false,
      depthWrite: false,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    scene.add(quad)
    return { scene, camera, material, quad }
  }, [resolution, terrainMap])

  useEffect(() => {
    return () => {
      targets[0].dispose()
      targets[1].dispose()
      simScene.quad.geometry.dispose()
      simScene.material.dispose()
    }
  }, [targets, simScene])

  const injectPointerUv = useCallback(
    (uv: THREE.Vector2, velocityBoost = 1.0) => {
      const p = pointerState.current
      if (!p.active || p.uv.x < 0) {
        p.prevUv.copy(uv)
      } else {
        p.prevUv.copy(p.uv)
      }
      p.uv.copy(uv)
      p.active = true
      p.radius = 0.036
      p.strength = Math.min(0.14, 0.028 * rippleStrength * velocityBoost)
    },
    [rippleStrength]
  )

  const triggerSplash = useCallback(
    (uv: THREE.Vector2, strength = 1.0) => {
      const p = pointerState.current
      p.prevUv.copy(uv)
      p.uv.copy(uv)
      p.active = true
      p.radius = 0.055
      p.strength = 0.075 * rippleStrength * strength
    },
    [rippleStrength]
  )

  useFrame((state) => {
    const { material, scene, camera } = simScene
    const p = pointerState.current

    const readIdx = pingPongIndex.current
    const writeIdx = 1 - readIdx

    material.uniforms.uPrevState.value = targets[readIdx].texture
    material.uniforms.uTerrainMap.value = terrainMap
    material.uniforms.uTime.value = state.clock.elapsedTime
    material.uniforms.uIdleWaveStrength.value = waveHeight
    material.uniforms.uWaterLevel.value = waterLevel

    if (p.active && p.strength > 0.0002) {
      material.uniforms.uDropCenter.value.copy(p.uv)
      material.uniforms.uPrevDropCenter.value.copy(p.prevUv)
      material.uniforms.uDropRadius.value = p.radius
      material.uniforms.uDropStrength.value = p.strength
      // Decay impulse rapidly so it acts as a crisp continuous wake as the pointer moves
      p.prevUv.copy(p.uv)
      p.strength *= 0.35
      if (p.strength < 0.0005) {
        p.active = false
        p.strength = 0
      }
    } else {
      material.uniforms.uDropStrength.value = 0.0
    }

    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    gl.autoClear = false
    gl.setRenderTarget(targets[writeIdx])
    gl.render(scene, camera)
    gl.setRenderTarget(prevTarget)
    gl.autoClear = prevAutoClear

    pingPongIndex.current = writeIdx
  })

  const getHeightfieldTexture = useCallback(() => {
    return targets[pingPongIndex.current].texture
  }, [targets])

  return {
    getHeightfieldTexture,
    injectPointerUv,
    triggerSplash,
  }
}
