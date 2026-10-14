import { useState, useMemo } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { Leva, useControls } from 'leva'
import { ResinDioramaScene } from './components/ResinDioramaScene'

function detectInitialLowPerf(): boolean {
  if (typeof window === 'undefined') return false
  const isTouchMobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900)
  const lowCores = navigator.hardwareConcurrency ? navigator.hardwareConcurrency <= 4 : false
  return isTouchMobile || (lowCores && window.innerWidth < 768)
}

export default function App() {
  const isLowPerf = useMemo(() => detectInitialLowPerf(), [])
  const [dpr, setDpr] = useState<number>(
    isLowPerf ? 1.0 : Math.min(window.devicePixelRatio || 1, 1.5)
  )

  const params = useControls('树脂微缩岛屿 · 参数面板', {
    waterColor: { value: '#12b5b0', label: '水色' },
    waveHeight: { value: 1.0, min: 0.0, max: 2.5, step: 0.05, label: '浪高' },
    rippleStrength: { value: 1.25, min: 0.1, max: 3.0, step: 0.05, label: '涟漪强度' },
    sunAzimuth: { value: 38, min: -180, max: 180, step: 1, label: '太阳角度' },
    tideLevel: { value: 1.48, min: 1.24, max: 1.68, step: 0.01, label: '潮位' },
    jellyStiffness: { value: 0.42, min: 0.1, max: 1.0, step: 0.02, label: '果冻软硬' },
    dofBokeh: { value: 1.5, min: 0.0, max: 6.0, step: 0.1, label: '景深' },
  })

  const blurPx = Math.max(0, params.dofBokeh * 1.25)

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      <Leva collapsed={false} oneLineLabels={false} flat={false} />

      <Canvas
        shadows
        dpr={dpr}
        camera={{
          position: [11.6, 10.5, 11.6],
          fov: 22.5,
          near: 1.0,
          far: 60.0,
        }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
      >
        <PerformanceMonitor
          ms={400}
          iterations={4}
          threshold={0.75}
          flipflops={2}
          bounds={(refreshrate) => (refreshrate > 90 ? [48, 88] : [32, 58])}
          onDecline={() => {
            setDpr(1.0)
          }}
          onFallback={() => {
            setDpr(1.0)
          }}
        >
          <ResinDioramaScene
            controls={{
              waterColor: params.waterColor,
              waveHeight: params.waveHeight,
              rippleStrength: params.rippleStrength,
              sunAzimuth: params.sunAzimuth,
              sunElevation: 52,
              tideLevel: params.tideLevel,
              jellyStiffness: params.jellyStiffness,
              dofBokeh: params.dofBokeh,
            }}
            isLowPerf={isLowPerf}
          />
        </PerformanceMonitor>
      </Canvas>

      {/* Tilt-shift miniature Depth of Field overlay controlled by dofBokeh */}
      {blurPx > 0.05 && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            backdropFilter: `blur(${blurPx.toFixed(2)}px)`,
            WebkitBackdropFilter: `blur(${blurPx.toFixed(2)}px)`,
            maskImage:
              'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.35) 14%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 72%, rgba(0,0,0,0.35) 86%, rgba(0,0,0,0.9) 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.35) 14%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 72%, rgba(0,0,0,0.35) 86%, rgba(0,0,0,0.9) 100%)',
          }}
        />
      )}

      {/* Subtle studio product photography vignette & warm bloom atmosphere */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(circle at 50% 48%, rgba(255,250,240,0.03) 0%, rgba(243,231,218,0.0) 56%, rgba(68,46,28,0.22) 100%)',
        }}
      />

      {/* Subtle studio caption overlay */}
      <div
        style={{
          position: 'fixed',
          left: '24px',
          bottom: '20px',
          pointerEvents: 'none',
          color: '#6b5b4b',
          fontSize: '12px',
          letterSpacing: '0.08em',
          opacity: 0.78,
          textShadow: '0 1px 2px rgba(255,255,255,0.6)',
        }}
      >
        RESIN ISLAND DIORAMA · 移动鼠标晃动果冻并拨动海面涟漪 / 点击激起浪花
      </div>
    </div>
  )
}
