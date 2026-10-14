import * as THREE from 'three'
import { Environment, ContactShadows, Lightformer } from '@react-three/drei'

export interface StudioStageProps {
  sunDirection: THREE.Vector3
  dofBokeh: number
  isLowPerf: boolean
}

function ProceduralStudioEnvironment() {
  return (
    <Environment resolution={128} frames={1}>
      <color attach="background" args={['#f6ece0']} />
      <Lightformer
        form="rect"
        intensity={2.6}
        color="#fffaf0"
        scale={[14, 14, 1]}
        position={[8, 12, 6]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={1.4}
        color="#d8f4f8"
        scale={[16, 10, 1]}
        position={[-10, 8, -8]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="ring"
        intensity={1.8}
        color="#ffe8c8"
        scale={10}
        position={[0, 14, 0]}
        rotation={[Math.PI / 2, 0, 0]}
      />
    </Environment>
  )
}

export function StudioStage({ sunDirection }: StudioStageProps) {
  const lightPos: [number, number, number] = [
    sunDirection.x * 16,
    sunDirection.y * 16,
    sunDirection.z * 16,
  ]

  return (
    <>
      {/* Warm cream product photography backdrop */}
      <color attach="background" args={['#f3e7da']} />

      {/* Ambient & Hemisphere fill for warm studio tones */}
      <ambientLight intensity={0.45} color="#fff6eb" />
      <hemisphereLight args={['#fff9f0', '#d6c1a7', 0.65]} position={[0, 12, 0]} />

      {/* Main directional sunlight casting warm soft cliff shadow across the bay and tabletop */}
      <directionalLight
        position={lightPos}
        intensity={2.45}
        color="#fff5e4"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={4}
        shadow-camera-far={30}
        shadow-camera-left={-4.5}
        shadow-camera-right={4.5}
        shadow-camera-top={4.5}
        shadow-camera-bottom={-4.5}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/* Subtle cool aqua rim light from ocean side to enhance crystal resin translucency */}
      <directionalLight position={[8, 4, -8]} intensity={0.55} color="#a6f5ef" />

      {/* Deterministic single-bake studio Environment (zero network fetch or lighting swap) */}
      <ProceduralStudioEnvironment />

      {/* Studio floor shadow-catcher for the long warm directional sun shadow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.004, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <shadowMaterial transparent opacity={0.17} color="#5e4128" />
      </mesh>

      {/* Soft grounded ContactShadows underneath the rounded resin block base (baked once on mount) */}
      <ContactShadows
        position={[0, 0.002, 0]}
        opacity={0.58}
        scale={10.5}
        blur={1.9}
        far={2.6}
        resolution={256}
        color="#432e1c"
        frames={1}
      />
    </>
  )
}
