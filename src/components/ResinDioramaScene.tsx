import { useMemo, useRef, useEffect } from 'react'
import * as THREE from 'three'
import { OrbitControls } from '@react-three/drei'
import {
  generateRocksData,
  generateVegetationData,
  createTerrainDataTexture,
} from '../utils/dioramaData'
import { useJellyPhysics } from '../hooks/useJellyPhysics'
import { useWaterSimulation } from '../hooks/useWaterSimulation'
import { Seabed } from './Seabed'
import { Island } from './Island'
import { Vegetation } from './Vegetation'
import { Rocks } from './Rocks'
import { ResinBlock } from './ResinBlock'
import { WaterSurface } from './WaterSurface'
import { StudioStage } from './StudioStage'

export interface DioramaControls {
  waterColor: string
  waveHeight: number
  rippleStrength: number
  sunAzimuth: number
  sunElevation: number
  tideLevel: number
  jellyStiffness: number
  dofBokeh: number
}

export interface ResinDioramaSceneProps {
  controls: DioramaControls
  isLowPerf: boolean
}

export function ResinDioramaScene({ controls, isLowPerf }: ResinDioramaSceneProps) {
  const dioramaGroupRef = useRef<THREE.Group>(null)

  // Precompute deterministic procedural rocks, canopy vegetation, and shared GPU height/obstacle DataTexture
  const { rocks, vegetation, terrainMap } = useMemo(() => {
    const r = generateRocksData()
    const v = generateVegetationData()
    const tMap = createTerrainDataTexture(r, 128)
    return { rocks: r, vegetation: v, terrainMap: tMap }
  }, [])

  useEffect(() => {
    return () => {
      terrainMap.dispose()
    }
  }, [terrainMap])

  // Convert sun azimuth & elevation (degrees) into normalized directional light vector
  const sunDirection = useMemo(() => {
    const az = (controls.sunAzimuth * Math.PI) / 180
    const el = (controls.sunElevation * Math.PI) / 180
    return new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    ).normalize()
  }, [controls.sunAzimuth, controls.sunElevation])

  // 1. Spring-driven Jelly Physics (top of block sways more than bottom)
  const { jellyUniforms, triggerJellyImpulse } = useJellyPhysics({
    stiffnessControl: controls.jellyStiffness,
    groupRef: dioramaGroupRef,
  })

  // 2. Independent GPU Ping-Pong Heightfield Water Simulation Hook
  const { getHeightfieldTexture, injectPointerUv, triggerSplash } = useWaterSimulation({
    resolution: 128,
    rippleStrength: controls.rippleStrength,
    waveHeight: controls.waveHeight,
    waterLevel: controls.tideLevel,
    terrainMap,
  })

  const handleWaterSplash = (uv: THREE.Vector2, strength = 1.0) => {
    triggerSplash(uv, strength)
    // Also give the jelly block a tactile elastic nudge when clicked
    triggerJellyImpulse((uv.x - 0.5) * 0.28, (uv.y - 0.5) * 0.28)
  }

  const meshSegments = isLowPerf ? 80 : 104

  return (
    <>
      <StudioStage
        sunDirection={sunDirection}
        dofBokeh={controls.dofBokeh}
        isLowPerf={isLowPerf}
      />

      <group ref={dioramaGroupRef}>
        {/* Sandy seabed with live caustics + bottom rounded sandy base plate */}
        <Seabed
          waterLevel={controls.tideLevel}
          waterColor={controls.waterColor}
          sunDirection={sunDirection}
          terrainMap={terrainMap}
          getHeightfieldTexture={getHeightfieldTexture}
          jellyUniforms={jellyUniforms}
          segments={isLowPerf ? 56 : 72}
        />

        {/* Procedural Kelingking-style limestone cliff & crescent sandy beach */}
        <Island
          waterLevel={controls.tideLevel}
          waterColor={controls.waterColor}
          sunDirection={sunDirection}
          jellyUniforms={jellyUniforms}
          segments={meshSegments}
        />

        {/* Instanced lush tropical canopy vegetation on cliff summit, spine, and ledges */}
        <Vegetation
          instances={vegetation}
          sunDirection={sunDirection}
          jellyUniforms={jellyUniforms}
        />

        {/* Instanced coastal emerging boulders & submerged mossy reef rocks */}
        <Rocks
          rocks={rocks}
          waterLevel={controls.tideLevel}
          waterColor={controls.waterColor}
          sunDirection={sunDirection}
          jellyUniforms={jellyUniforms}
        />

        {/* Rounded-square transparent resin block walls with MeshTransmissionMaterial */}
        <ResinBlock
          waterLevel={controls.tideLevel}
          waterColor={controls.waterColor}
          jellyUniforms={jellyUniforms}
          isLowPerf={isLowPerf}
        />

        {/* Dynamic GPU heightfield water surface with ripples, reflection, depth tint, and shore foam */}
        <WaterSurface
          waterLevel={controls.tideLevel}
          waterColor={controls.waterColor}
          waveHeight={controls.waveHeight}
          sunDirection={sunDirection}
          terrainMap={terrainMap}
          getHeightfieldTexture={getHeightfieldTexture}
          injectPointerUv={injectPointerUv}
          triggerSplash={handleWaterSplash}
          jellyUniforms={jellyUniforms}
          segments={meshSegments}
        />
      </group>

      <OrbitControls
        makeDefault
        target={[0, 1.15, 0]}
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.45}
        minDistance={12}
        maxDistance={28}
        minPolarAngle={Math.PI * 0.18}
        maxPolarAngle={Math.PI * 0.41}
        minAzimuthAngle={-Math.PI * 0.15}
        maxAzimuthAngle={Math.PI * 0.65}
      />
    </>
  )
}
