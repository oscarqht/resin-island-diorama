import { useMemo, useRef, useLayoutEffect, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { RockInstanceData, fbm2D } from '../utils/dioramaData'
import { JELLY_VERTEX_PARS, JellyUniforms } from '../utils/jellyShader'

export interface RocksProps {
  rocks: RockInstanceData[]
  waterLevel: number
  waterColor: string
  sunDirection: THREE.Vector3
  jellyUniforms: JellyUniforms
}

function createProceduralBoulderGeometry(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 3)
  const pos = geo.attributes.position as THREE.BufferAttribute

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i)
    let y = pos.getY(i)
    let z = pos.getZ(i)

    // Angular craggy rock displacement
    const rNoise = 1.0 - Math.abs(fbm2D(x * 1.9 + y * 0.8, z * 1.9 - y * 0.7, 3))
    const detail = fbm2D(x * 3.8 + z * 1.2, z * 3.8 - x * 1.4, 3)
    const disp = 0.74 + rNoise * 0.34 + detail * 0.14

    x *= disp
    z *= disp
    // Flatten underside slightly so boulders sit naturally in the sand
    y = y < 0 ? y * 0.58 * disp : y * disp * 0.86

    pos.setXYZ(i, x, y, z)
  }

  geo.computeVertexNormals()
  return geo
}

const ROCKS_VERTEX_SHADER = /* glsl */ `
${JELLY_VERTEX_PARS}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;

void main() {
  vLocalPos = position;
  vec4 instPos = instanceMatrix * vec4(position, 1.0);
  vec4 worldPosition = modelMatrix * instPos;

  vWorldPos = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

  worldPosition.xyz = applyJellyDeformation(worldPosition.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

const ROCKS_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uWaterColor;
uniform vec3 uSunDirection;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;

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

void main() {
  float n1 = noise3(vWorldPos * 8.5);
  float n2 = noise3(vWorldPos * 22.0 + 4.7);
  float rockBump = n1 * 0.65 + n2 * 0.35;

  vec3 dpdx = dFdx(vWorldPos);
  vec3 dpdy = dFdy(vWorldPos);
  vec3 N = normalize(vWorldNormal - (dpdx * dFdx(rockBump) + dpdy * dFdy(rockBump)) * 8.0);

  vec3 L = normalize(uSunDirection);
  float ndl = max(0.16, dot(N, L));

  // Warm limestone & dark charcoal coastal rock palette
  vec3 dryRock = mix(vec3(0.46, 0.39, 0.31), vec3(0.68, 0.59, 0.47), n1);
  vec3 darkReefRock = mix(vec3(0.14, 0.24, 0.21), vec3(0.24, 0.34, 0.26), n2);

  float height = vWorldPos.y;
  float subDepth = uWaterLevel - height;

  // Wet dark rim right around water line
  float wetBand = smoothstep(0.12, -0.02, height - uWaterLevel);
  vec3 rockAlbedo = mix(dryRock, dryRock * 0.52, wetBand);

  // Submerged reef rock color
  float underwaterMask = smoothstep(-0.02, 0.14, subDepth);
  rockAlbedo = mix(rockAlbedo, darkReefRock, underwaterMask * 0.85);

  vec3 litRock = rockAlbedo * (0.32 + 0.74 * ndl);

  // Add underwater caustics and turquoise depth tint when submerged
  if (subDepth > 0.0) {
    float upwardFace = smoothstep(0.05, 0.75, N.y);
    float c1 = sin(vWorldPos.x * 11.0 + uTime * 2.0 + cos(vWorldPos.z * 9.5 - uTime * 1.5));
    float c2 = cos(vWorldPos.z * 12.5 - uTime * 1.7 + sin(vWorldPos.x * 10.2 + uTime * 1.3));
    float caustic = pow(clamp((c1 * c2) * 0.5 + 0.5, 0.0, 1.0), 3.4) * upwardFace;

    litRock += vec3(0.62, 0.98, 0.94) * caustic * 0.52 * smoothstep(1.3, 0.05, subDepth);

    vec3 waterTint = mix(
      vec3(0.38, 0.90, 0.86),
      uWaterColor * vec3(0.16, 0.52, 0.66),
      clamp(subDepth / 1.15, 0.0, 1.0)
    );
    float absorb = 1.0 - exp(-subDepth * 1.35);
    litRock = mix(litRock, waterTint * 0.65, absorb * 0.58);
  }

  gl_FragColor = vec4(litRock, 1.0);
}
`

export function Rocks({
  rocks,
  waterLevel,
  waterColor,
  sunDirection,
  jellyUniforms,
}: RocksProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const matRef = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => createProceduralBoulderGeometry(), [])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
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

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    const dummy = new THREE.Object3D()
    rocks.forEach((rock, i) => {
      dummy.position.set(rock.position[0], rock.position[1], rock.position[2])
      dummy.rotation.set(rock.rotation[0], rock.rotation[1], rock.rotation[2])
      dummy.scale.set(rock.scale[0], rock.scale[1], rock.scale[2])
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
  }, [rocks])

  useFrame((state) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = state.clock.elapsedTime
      matRef.current.uniforms.uWaterLevel.value = waterLevel
      matRef.current.uniforms.uWaterColor.value.set(waterColor)
      matRef.current.uniforms.uSunDirection.value.copy(sunDirection)
    }
  })

  return (
    <instancedMesh ref={meshRef} args={[geometry, undefined, rocks.length]} castShadow receiveShadow>
      <shaderMaterial
        ref={matRef}
        vertexShader={ROCKS_VERTEX_SHADER}
        fragmentShader={ROCKS_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </instancedMesh>
  )
}
