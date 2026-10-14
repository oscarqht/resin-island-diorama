import { useRef, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { createJellyUniforms, JellyUniforms } from '../utils/jellyShader'

export interface UseJellyPhysicsOptions {
  stiffnessControl: number // 0.1 (very soft wobble) to 1.0 (firm elastic jelly)
  groupRef: React.RefObject<THREE.Group | null>
}

export function useJellyPhysics({ stiffnessControl, groupRef }: UseJellyPhysicsOptions): {
  jellyUniforms: JellyUniforms
  triggerJellyImpulse: (ix: number, iz: number) => void
} {
  const jellyUniforms = useMemo(() => createJellyUniforms(), [])

  const physics = useRef({
    pos: new THREE.Vector2(0, 0),
    vel: new THREE.Vector2(0, 0),
    prevPointer: new THREE.Vector2(0, 0),
    initialized: false,
  })

  const triggerJellyImpulse = (ix: number, iz: number) => {
    const softness = 1.25 - stiffnessControl * 0.75
    physics.current.vel.x += ix * 2.2 * softness
    physics.current.vel.y += iz * 2.2 * softness
  }

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.033)
    const p = physics.current
    const pointer = state.pointer

    if (!p.initialized) {
      p.prevPointer.copy(pointer)
      p.initialized = true
    }

    // Compute pointer velocity in NDC space
    const pointerDx = pointer.x - p.prevPointer.x
    const pointerDy = pointer.y - p.prevPointer.y
    p.prevPointer.copy(pointer)

    // Map camera-space pointer (x, y) to world XZ plane (camera looks from +X, +Z toward -X, -Z)
    // Screen right (+pointer.x) is roughly (+X - Z), screen up (+pointer.y) is roughly (-X - Z)
    const worldTargetX = (pointer.x * 0.707 - pointer.y * 0.707) * 0.26
    const worldTargetZ = (-pointer.x * 0.707 - pointer.y * 0.707) * 0.26

    const worldImpulseX = (pointerDx * 0.707 - pointerDy * 0.707) * 16.0
    const worldImpulseZ = (-pointerDx * 0.707 - pointerDy * 0.707) * 16.0

    // Map Leva `jellyStiffness` (0.1 .. 1.0) to spring frequency & damping ratio
    // Lower stiffness = softer, bigger amplitude, longer wobble tail
    const softness = 1.35 - stiffnessControl * 0.85
    const springK = 28.0 + stiffnessControl * 65.0
    const damping = 2.4 + stiffnessControl * 3.8

    // Inject pointer velocity impulse into spring velocity for reactive jello wobble
    p.vel.x += worldImpulseX * softness * 0.35
    p.vel.y += worldImpulseZ * softness * 0.35

    // Harmonic spring force toward target pointer offset
    const forceX = (worldTargetX * softness - p.pos.x) * springK - p.vel.x * damping
    const forceZ = (worldTargetZ * softness - p.pos.y) * springK - p.vel.y * damping

    p.vel.x += forceX * dt
    p.vel.y += forceZ * dt
    p.pos.x += p.vel.x * dt
    p.pos.y += p.vel.y * dt

    // Update shared shader uniforms (top vertices shear/bend much more than bottom vertices)
    jellyUniforms.uJellyOffset.value.set(p.pos.x, p.pos.y)
    jellyUniforms.uJellyVelocity.value.set(p.vel.x * 0.18, p.vel.y * 0.18)
    jellyUniforms.uJellyTime.value = state.clock.elapsedTime
    jellyUniforms.uJellyStrength.value = softness

    // Subtle whole-block base spring response (keeps bottom mostly planted while whole block subtly rocks)
    if (groupRef.current) {
      groupRef.current.rotation.z = -p.pos.x * 0.085
      groupRef.current.rotation.x = p.pos.y * 0.085
      groupRef.current.position.x = p.pos.x * 0.12
      groupRef.current.position.z = p.pos.y * 0.12
    }
  })

  return { jellyUniforms, triggerJellyImpulse }
}
