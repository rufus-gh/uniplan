import { useEffect, useRef } from 'react'

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uMouse;
uniform float uMouseActive;
uniform sampler2D uAtlas;
uniform vec2 uAtlasCells;

uniform float uCellSize;
uniform float uAppear;
uniform float uIsLight;

// Strip 1
uniform float uCenterX1;
uniform float uCenterY1;
uniform float uRadiusX1;
uniform float uRadiusY1;
uniform float uThickness1;
uniform float uThickVary1;
uniform float uThickFreq1;
uniform float uSpeed1;

// Strip 2
uniform vec2  uFlip2;
uniform float uCenterX2;
uniform float uCenterY2;
uniform float uRadiusX2;
uniform float uRadiusY2;
uniform float uThickness2;
uniform float uThickVary2;
uniform float uThickFreq2;
uniform float uSpeed2;

varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);

  // --- MOUSE SPOTLIGHT (Dynamic & Focused) ---
  vec2 dMouse = (uv - uMouse) * aspect;
  float mouseDist = length(dMouse);

  // High-contrast, multi-tiered focus:
  // 1. Sharp focal core right around pointer (~50px)
  float coreGlow = exp(-mouseDist * mouseDist * 210.0) * uMouseActive;
  // 2. Medium aura (~130px)
  float midGlow = exp(-mouseDist * mouseDist * 42.0) * uMouseActive;
  // 3. Wide subtle halo (~240px)
  float outerGlow = exp(-mouseDist * mouseDist * 12.0) * uMouseActive;

  // --- GLYPH GRID & ATLAS SAMPLING ---
  float cellPx = uCellSize;
  vec2 pixel = uv * uResolution;
  vec2 grid = pixel / cellPx;
  vec2 cellId = floor(grid);
  vec2 local = fract(grid);

  float n = hash21(cellId);
  float shimmer = sin(n * 12.56 + uTime * 1.6) * 0.5 + 0.5;

  // Rapid hacker-scramble right under the pointer
  float mouseScramble = coreGlow * 30.0 + midGlow * 8.0;
  float glyphCount = uAtlasCells.x * uAtlasCells.y;
  float scramble = floor(uTime * 1.5 + n * 3.0 + mouseScramble);
  float glyphIndex = mod(floor(n * glyphCount) + scramble, glyphCount);

  float gx = mod(glyphIndex, uAtlasCells.x);
  float gy = floor(glyphIndex / uAtlasCells.x);
  vec2 atlasUv = vec2(
    (gx + local.x) / uAtlasCells.x,
    (gy + 1.0 - local.y) / uAtlasCells.y
  );
  float glyph = texture2D(uAtlas, atlasUv).r;
  glyph = smoothstep(0.18, 0.75, glyph);

  // --- STRIP 1 GEOMETRY (Top-Left Anchor) ---
  vec2 p1 = vec2((uv.x - uCenterX1) / uRadiusX1, (uv.y - uCenterY1) / uRadiusY1);
  float r1 = length(p1);
  float angle1 = atan(p1.y, p1.x); // [-PI/2 to 0]
  float dArc1 = abs(r1 - 1.0) * ((uRadiusX1 + uRadiusY1) * 0.5);

  // --- STRIP 2 GEOMETRY (Bottom-Right Anchor) ---
  vec2 uv2 = vec2(uFlip2.x > 0.5 ? 1.0 - uv.x : uv.x, uFlip2.y > 0.5 ? 1.0 - uv.y : uv.y);
  vec2 p2 = vec2((uv2.x - uCenterX2) / uRadiusX2, (uv2.y - uCenterY2) / uRadiusY2);
  float r2 = length(p2);
  float angle2 = atan(p2.y, p2.x);
  float dArc2 = abs(r2 - 1.0) * ((uRadiusX2 + uRadiusY2) * 0.5);

  // Mouse proximity reaction on ribbons (ribbon reacts when cursor is near)
  float mouseNearR1 = exp(-length(uv - uMouse) * 7.0) * uMouseActive;
  float mouseNearR2 = exp(-length(uv - uMouse) * 7.0) * uMouseActive;

  // Entrance sweep
  float appearProg = clamp(uAppear, 0.0, 1.0);
  float normAngle1 = clamp((-angle1) / 1.57079, 0.0, 1.0);
  float drawProg1 = appearProg * 1.35;
  float drawMask1 = smoothstep(0.0, 0.22, drawProg1 - normAngle1 * 0.95);
  float tipDist1 = abs(drawProg1 - normAngle1 * 0.95);
  float tipFactor1 = smoothstep(0.18, 0.0, tipDist1) * (1.0 - appearProg * 0.75);

  // Strip 1 Band (controlled thickness, sleek and defined)
  float thick1 = uThickness1 + uThickVary1 * sin(angle1 * uThickFreq1 - uTime * uSpeed1 + n * 0.5) + mouseNearR1 * 0.05;
  float band1 = 1.0 - smoothstep(thick1 * 0.28, thick1, dArc1);
  band1 *= smoothstep(-1.95, -1.30, angle1) * (1.0 - smoothstep(-0.25, 0.20, angle1));
  band1 *= drawMask1;

  // Strip 1 Lighting (refined monochrome, dark base with silver crests)
  vec3 col1 = vec3(0.0);
  if (band1 > 0.001) {
    float core1 = 1.0 - smoothstep(0.0, thick1 * 0.22, dArc1);
    float spine1 = core1 * core1;
    float flow1 = angle1 * 2.8 - uTime * 0.85;
    float wavePulse1 = pow(sin(flow1) * 0.5 + 0.5, 3.0);
    float waveHigh1 = pow(sin(angle1 * 1.6 - uTime * 1.15) * 0.5 + 0.5, 5.0);

    float ribbonDensity1 = (0.20 + 0.60 * n) * (0.65 + 0.35 * shimmer);
    ribbonDensity1 *= (0.4 + 0.6 * wavePulse1);

    vec3 rChar1 = mix(vec3(0.18, 0.18, 0.20), vec3(0.68, 0.68, 0.72), wavePulse1 * 0.6 + spine1 * 0.4);
    rChar1 = mix(rChar1, vec3(0.95, 0.95, 1.00), waveHigh1 * spine1 + mouseNearR1 * 0.25);

    vec3 rBody1 = vec3(0.045, 0.045, 0.05) * band1;
    vec3 rHighlight1 = vec3(0.50, 0.50, 0.55) * spine1 * waveHigh1 * 0.4;
    vec3 tipGlow1 = vec3(0.85, 0.85, 0.90) * tipFactor1 * 0.25;

    col1 = (rBody1 + rChar1 * glyph * ribbonDensity1 + rHighlight1 + tipGlow1) * band1;
  }

  // Entrance sweep Strip 2
  float appearProg2 = clamp((appearProg - 0.06) * 1.25, 0.0, 1.0);
  float normAngle2 = clamp((-angle2) / 1.57079, 0.0, 1.0);
  float drawProg2 = appearProg2 * 1.35;
  float drawMask2 = smoothstep(0.0, 0.22, drawProg2 - normAngle2 * 0.95);
  float tipDist2 = abs(drawProg2 - normAngle2 * 0.95);
  float tipFactor2 = smoothstep(0.18, 0.0, tipDist2) * (1.0 - appearProg2 * 0.75);

  // Strip 2 Band
  float thick2 = uThickness2 + uThickVary2 * sin(angle2 * uThickFreq2 - uTime * uSpeed2 + n * 0.5 + 1.6) + mouseNearR2 * 0.05;
  float band2 = 1.0 - smoothstep(thick2 * 0.28, thick2, dArc2);
  band2 *= smoothstep(-1.95, -1.30, angle2) * (1.0 - smoothstep(-0.25, 0.20, angle2));
  band2 *= drawMask2;

  // Strip 2 Lighting
  vec3 col2 = vec3(0.0);
  if (band2 > 0.001) {
    float core2 = 1.0 - smoothstep(0.0, thick2 * 0.22, dArc2);
    float spine2 = core2 * core2;
    float flow2 = angle2 * 2.4 - uTime * 0.75 + 1.8;
    float wavePulse2 = pow(sin(flow2) * 0.5 + 0.5, 3.0);
    float waveHigh2 = pow(sin(angle2 * 1.8 - uTime * 0.95 + 2.4) * 0.5 + 0.5, 5.0);

    float ribbonDensity2 = (0.20 + 0.60 * n) * (0.65 + 0.35 * shimmer);
    ribbonDensity2 *= (0.4 + 0.6 * wavePulse2);

    vec3 rChar2 = mix(vec3(0.18, 0.18, 0.20), vec3(0.68, 0.68, 0.72), wavePulse2 * 0.6 + spine2 * 0.4);
    rChar2 = mix(rChar2, vec3(0.95, 0.95, 1.00), waveHigh2 * spine2 + mouseNearR2 * 0.25);

    vec3 rBody2 = vec3(0.045, 0.045, 0.05) * band2;
    vec3 rHighlight2 = vec3(0.50, 0.50, 0.55) * spine2 * waveHigh2 * 0.4;
    vec3 tipGlow2 = vec3(0.85, 0.85, 0.90) * tipFactor2 * 0.25;

    col2 = (rBody2 + rChar2 * glyph * ribbonDensity2 + rHighlight2 + tipGlow2) * band2;
  }

  // --- AMBIENT VOID (Deep pitch black, sparse delicate shimmering glyphs) ---
  vec3 baseBg = mix(vec3(0.039, 0.039, 0.043), vec3(0.988, 0.988, 0.992), uIsLight);

  float ambientTwinkle = sin(n * 12.56 + uTime * 1.2) * 0.5 + 0.5;
  float cellActive = step(0.48, n);
  float ambientGlyph = glyph * cellActive * (0.025 + 0.025 * ambientTwinkle);
  vec3 ambientColor = mix(vec3(0.18, 0.18, 0.20), vec3(0.78, 0.78, 0.80), uIsLight) * ambientGlyph;

  // --- MOUSE SPOTLIGHT (Dynamic revelation of dense glowing characters) ---
  float mouseCharDensity = clamp(coreGlow * 1.0 + midGlow * 0.5, 0.0, 0.7);
  vec3 mouseCharColor = mix(vec3(0.30, 0.30, 0.34), vec3(0.62, 0.62, 0.66), coreGlow);
  float mouseCharLight = glyph * mouseCharDensity;

  vec3 spotlightDisc = vec3(0.05, 0.05, 0.06) * midGlow + vec3(0.11, 0.11, 0.12) * coreGlow;

  // --- COMPOSITION ---
  vec3 ribbons = col1 + col2;
  if (band1 > 0.001 && band2 > 0.001) {
    ribbons = mix(max(col1, col2), col1 + col2, 0.4);
  }

  vec3 composite = baseBg + ambientColor;
  if (uIsLight > 0.5) {
    composite -= ribbons * 0.75;
    composite -= spotlightDisc * 0.5;
    composite -= (vec3(1.0) - mouseCharColor) * mouseCharLight * 0.8;
  } else {
    composite += ribbons;
    composite += spotlightDisc;
    composite += mouseCharColor * mouseCharLight;
  }

  // Smooth cinematic tone mapping: prevents ANY overexposure or clipping
  if (uIsLight < 0.5) {
    composite = vec3(1.0) - exp(-composite * 1.04);
  }

  gl_FragColor = vec4(composite, 1.0);
}
`

function createAtlas() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '700 42px "JetBrains Mono Variable", ui-monospace, Menlo, monospace'

  // 32 glyphs: 8 columns x 4 rows (memorable.sh matrix + math symbols for Lemma)
  const chars = '@#$%&8SX0B*=+{}()<>/\\|;:~∫∑√πλ∞∆'
  for (let i = 0; i < 32; i++) {
    const col = i % 8
    const row = Math.floor(i / 8)
    const x = col * 64 + 32
    const y = row * 64 + 33.28
    ctx.fillText(chars[i] || '#', x, y)
  }
  return { canvas, cols: 8, rows: 4 }
}

export interface MemorableBackgroundProps {
  active?: boolean
}

export function MemorableBackground({ active = true }: MemorableBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    activeRef.current = active
    if (active) {
      wakeRef.current()
    }
  }, [active])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    })
    if (!gl) {
      console.warn('WebGL not supported for MemorableBackground')
      return
    }

    // Compile helper
    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
      }
      return shader
    }

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vs || !fs) return

    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program))
      return
    }
    gl.useProgram(program)

    // Quad geometry
    const posBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1
      ]),
      gl.STATIC_DRAW
    )
    const aPos = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    // Texture Atlas
    const atlas = createAtlas()
    if (!atlas) return
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas)

    // Uniform locations
    const loc = (name: string) => gl.getUniformLocation(program, name)
    const uTime = loc('uTime')
    const uResolution = loc('uResolution')
    const uMouse = loc('uMouse')
    const uMouseActive = loc('uMouseActive')
    const uAtlas = loc('uAtlas')
    const uAtlasCells = loc('uAtlasCells')
    const uCellSize = loc('uCellSize')
    const uAppear = loc('uAppear')
    const uIsLight = loc('uIsLight')

    // Strip 1
    const uCenterX1 = loc('uCenterX1')
    const uCenterY1 = loc('uCenterY1')
    const uRadiusX1 = loc('uRadiusX1')
    const uRadiusY1 = loc('uRadiusY1')
    const uThickness1 = loc('uThickness1')
    const uThickVary1 = loc('uThickVary1')
    const uThickFreq1 = loc('uThickFreq1')
    const uSpeed1 = loc('uSpeed1')

    // Strip 2
    const uFlip2 = loc('uFlip2')
    const uCenterX2 = loc('uCenterX2')
    const uCenterY2 = loc('uCenterY2')
    const uRadiusX2 = loc('uRadiusX2')
    const uRadiusY2 = loc('uRadiusY2')
    const uThickness2 = loc('uThickness2')
    const uThickVary2 = loc('uThickVary2')
    const uThickFreq2 = loc('uThickFreq2')
    const uSpeed2 = loc('uSpeed2')

    // Static uniforms
    gl.uniform1i(uAtlas, 0)
    gl.uniform2f(uAtlasCells, atlas.cols, atlas.rows)

    // Strip 1 parameters (curving from top-left, sleek thickness)
    gl.uniform1f(uCenterX1, -0.04)
    gl.uniform1f(uCenterY1, 1.04)
    gl.uniform1f(uRadiusX1, 0.74)
    gl.uniform1f(uRadiusY1, 0.90)
    gl.uniform1f(uThickness1, 0.38)
    gl.uniform1f(uThickVary1, 0.07)
    gl.uniform1f(uThickFreq1, 2.8)
    gl.uniform1f(uSpeed1, 0.75)

    // Strip 2 parameters (mirrored, curving from bottom-right)
    gl.uniform2f(uFlip2, 1.0, 1.0)
    gl.uniform1f(uCenterX2, -0.32)
    gl.uniform1f(uCenterY2, 1.06)
    gl.uniform1f(uRadiusX2, 0.62)
    gl.uniform1f(uRadiusY2, 0.43)
    gl.uniform1f(uThickness2, 0.32)
    gl.uniform1f(uThickVary2, 0.07)
    gl.uniform1f(uThickFreq2, 3.4)
    gl.uniform1f(uSpeed2, 0.65)

    // Interactive mouse state
    const mouse = {
      currX: -999,
      currY: -999,
      targX: -999,
      targY: -999,
      active: 0,
      activeTarget: 0,
      lastMove: 0,
      isHovering: false
    }

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const x = (e.clientX - rect.left) / rect.width
      const y = 1.0 - (e.clientY - rect.top) / rect.height

      // Active inside the main panel
      if (x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05) {
        mouse.targX = x
        mouse.targY = y
        mouse.isHovering = true
        mouse.activeTarget = 1.0
        mouse.lastMove = performance.now()
        wake()
      } else {
        mouse.isHovering = false
        mouse.activeTarget = 0.0
      }
    }

    const onPointerDown = () => {
      if (mouse.isHovering) {
        // Tactile surge on click
        mouse.active = 1.0
        wake()
      }
    }

    const onPointerLeave = () => {
      mouse.isHovering = false
      mouse.activeTarget = 0.0
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave, { passive: true })

    // Resize handling
    const resize = () => {
      if (!container || !canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const w = container.clientWidth || window.innerWidth
      const h = container.clientHeight || window.innerHeight
      const renderW = Math.floor(w * dpr)
      const renderH = Math.floor(h * dpr)

      if (canvas.width !== renderW || canvas.height !== renderH) {
        canvas.width = renderW
        canvas.height = renderH
        gl.viewport(0, 0, renderW, renderH)
      }
      gl.uniform2f(uResolution, renderW, renderH)
      const cellSize = (w < 768 ? 14 : 17) * dpr
      gl.uniform1f(uCellSize, cellSize)
    }

    window.addEventListener('resize', resize)
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    resize()

    // Animation loop
    let rafId: number | null = null
    const startTime = performance.now()
    let lastTime = startTime
    let accumulatedTime = 0
    let isVisible = true

    const render = (now: number) => {
      if (!activeRef.current || !isVisible || document.hidden) {
        rafId = null
        return
      }

      rafId = requestAnimationFrame(render)

      const dt = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now
      accumulatedTime += dt

      // Smooth entrance sweep over 2.0s
      const appearProg = Math.min((now - startTime) / 2000, 1.0)
      const easedAppear = 1.0 - Math.pow(1.0 - appearProg, 2.5)

      // Mouse decay & responsiveness:
      // While mouse is inside window, ease down to a resting glow (0.50) when still
      // rather than turning off completely!
      if (mouse.isHovering) {
        if (now - mouse.lastMove > 350) {
          mouse.activeTarget = 0.40
        }
      } else {
        mouse.activeTarget = 0.0
      }

      // Snappy lerp (0.26) for responsive cursor spotlight
      mouse.currX += (mouse.targX - mouse.currX) * 0.26
      mouse.currY += (mouse.targY - mouse.currY) * 0.26
      mouse.active += (mouse.activeTarget - mouse.active) * 0.12

      // Check theme
      const isLight = document.documentElement.dataset.theme === 'light' ? 1.0 : 0.0

      // Update uniforms
      gl.uniform1f(uTime, accumulatedTime)
      gl.uniform1f(uAppear, easedAppear)
      gl.uniform1f(uIsLight, isLight)
      gl.uniform2f(uMouse, mouse.currX, mouse.currY)
      gl.uniform1f(uMouseActive, mouse.active)

      // Draw
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const wake = () => {
      if (!rafId && activeRef.current && isVisible && !document.hidden) {
        lastTime = performance.now()
        rafId = requestAnimationFrame(render)
      }
    }
    wakeRef.current = wake

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
      } else {
        wake()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          isVisible = e.isIntersecting
          if (isVisible) wake()
          else if (rafId) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
        })
      },
      { threshold: 0.05 }
    )
    intersectionObserver.observe(container)

    wake()

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      gl.deleteTexture(tex)
      gl.deleteBuffer(posBuffer)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`memorable-bg ${active ? 'active' : ''}`}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="memorable-canvas" />
      <div className="memorable-vignette-top" />
      <div className="memorable-vignette-bottom" />
    </div>
  )
}
