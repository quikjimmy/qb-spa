<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const reducedMotion = ref(false)

const SHADER_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const SHADER_PRELUDE = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform vec3  u_click;
uniform float u_pressed;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.,0.));
  float c = hash(i + vec2(0.,1.)), d = hash(i + vec2(1.,1.));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
`

const FRAG_TOPO = SHADER_PRELUDE + `
float sdBoxT(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,0.0)) + min(max(d.x,d.y), 0.0); }

float kinGlyphT(vec2 p, float scale){
  p /= scale;
  float topBar = sdBoxT(p - vec2(0.0, 0.30), vec2(0.36, 0.05));
  float botBar = sdBoxT(p - vec2(0.0,-0.30), vec2(0.36, 0.05));
  float stem   = sdBoxT(p - vec2(0.0,-0.05), vec2(0.04, 0.30));
  vec2 q = p - vec2(0.0, 0.05);
  float ang = 0.55;
  mat2 RL = mat2(cos(ang),-sin(ang),sin(ang),cos(ang));
  mat2 RR = mat2(cos(-ang),-sin(-ang),sin(-ang),cos(-ang));
  float armL = sdBoxT(RL*(q + vec2(0.18,0.0)), vec2(0.22, 0.05));
  float armR = sdBoxT(RR*(q - vec2(0.18,0.0)), vec2(0.22, 0.05));
  return min(min(topBar, botBar), min(stem, min(armL, armR))) * scale;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 asp = vec2(u_resolution.x/u_resolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp;
  vec2 m = (u_mouse - 0.5) * asp;

  float e = fbm(p*2.4 + u_time*0.04);
  e += 0.6 * fbm(p*5.0 - u_time*0.03);

  float md = length(p - m);
  e += 0.45 * exp(-md*md*5.0);

  vec2 cl = (u_click.xy - 0.5)*asp;
  float cd = length(p - cl);
  e += 0.6 * exp(-cd*cd*15.0) * exp(-u_click.z*0.6);

  float lines = abs(fract(e * 9.0) - 0.5);
  float w = fwidth(e * 9.0);
  float contour = 1.0 - smoothstep(0.0, w*1.2, lines);

  float majorLines = abs(fract(e * 1.8) - 0.5);
  float wm = fwidth(e * 1.8);
  float major = 1.0 - smoothstep(0.0, wm*1.5, majorLines);

  vec3 bg     = vec3(0.060, 0.090, 0.140);
  vec3 bgHigh = vec3(0.110, 0.150, 0.220);
  vec3 line   = vec3(0.78, 0.84, 0.96);
  vec3 amber  = vec3(0.957, 0.741, 0.439);

  vec3 base = mix(bg, bgHigh, smoothstep(0.0, 1.5, e));
  vec3 col  = mix(base, line, contour*0.55);
  col = mix(col, amber, major*smoothstep(0.4, 0.0, md)*0.9);
  col = mix(col, line, major*0.3);

  vec2 cp = p - m;
  float gscale = 0.055;
  float gd = kinGlyphT(cp, gscale);
  float halo = smoothstep(gscale*0.55, gscale*0.20, length(cp)) * 0.12;
  float glyphFill = smoothstep(0.002, 0.0, gd);
  float glyphOutline = smoothstep(0.0028, 0.0014, abs(gd - 0.0008));
  col = mix(col, vec3(0.957, 0.741, 0.439), glyphFill);
  col = mix(col, vec3(0.060, 0.090, 0.140), glyphOutline*0.55);
  col += halo * vec3(0.957, 0.741, 0.439);

  vec2 g = fract(p*6.0)-0.5;
  float dot_ = smoothstep(0.04, 0.02, length(g));
  col += dot_ * 0.04;

  gl_FragColor = vec4(col, 1.0);
}
`

let cleanup: (() => void) | null = null

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (mq.matches) {
    reducedMotion.value = true
    return
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false })
  if (!gl) {
    reducedMotion.value = true
    return
  }
  gl.getExtension('OES_standard_derivatives')

  function compile(type: number, src: string) {
    const s = gl!.createShader(type)!
    gl!.shaderSource(s, src)
    gl!.compileShader(s)
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
      console.error('shader compile error:', gl!.getShaderInfoLog(s))
    }
    return s
  }

  const vs = compile(gl.VERTEX_SHADER, SHADER_VS)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG_TOPO)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  )
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const uTime = gl.getUniformLocation(prog, 'u_time')
  const uRes = gl.getUniformLocation(prog, 'u_resolution')
  const uMouse = gl.getUniformLocation(prog, 'u_mouse')
  const uClick = gl.getUniformLocation(prog, 'u_click')
  const uPressed = gl.getUniformLocation(prog, 'u_pressed')

  function resize() {
    const rect = canvas!.getBoundingClientRect()
    canvas!.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas!.height = Math.max(1, Math.floor(rect.height * dpr))
    gl!.viewport(0, 0, canvas!.width, canvas!.height)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  const state = {
    mouse: [0.5, 0.5] as [number, number],
    target: [0.5, 0.5] as [number, number],
    click: [0.5, 0.5, 0] as [number, number, number],
    pressed: 0,
  }

  const t0 = performance.now()
  let raf = 0
  let running = true

  function frame() {
    if (!running) return
    const t = (performance.now() - t0) / 1000
    state.mouse[0] += (state.target[0] - state.mouse[0]) * 0.08
    state.mouse[1] += (state.target[1] - state.mouse[1]) * 0.08

    gl!.uniform1f(uTime, t)
    gl!.uniform2f(uRes, canvas!.width, canvas!.height)
    gl!.uniform2f(uMouse, state.mouse[0], state.mouse[1])
    gl!.uniform3f(uClick, state.click[0], state.click[1], t - state.click[2])
    gl!.uniform1f(uPressed, state.pressed)
    gl!.drawArrays(gl!.TRIANGLES, 0, 6)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      running = false
    } else if (!running) {
      running = true
      raf = requestAnimationFrame(frame)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  function ptr(e: PointerEvent) {
    const r = canvas!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = 1 - (e.clientY - r.top) / r.height
    state.target = [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
  }
  function down(e: PointerEvent) {
    ptr(e)
    const t = (performance.now() - t0) / 1000
    state.click = [state.target[0], state.target[1], t]
    state.pressed = 1
  }
  function up() {
    state.pressed = 0
  }

  window.addEventListener('pointermove', ptr)
  window.addEventListener('pointerdown', down)
  window.addEventListener('pointerup', up)

  cleanup = () => {
    running = false
    cancelAnimationFrame(raf)
    ro.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointermove', ptr)
    window.removeEventListener('pointerdown', down)
    window.removeEventListener('pointerup', up)
    gl!.deleteProgram(prog)
    gl!.deleteShader(vs)
    gl!.deleteShader(fs)
    gl!.deleteBuffer(buf)
  }
})

onBeforeUnmount(() => {
  cleanup?.()
})
</script>

<template>
  <div class="login-shader-root">
    <canvas
      v-if="!reducedMotion"
      ref="canvasRef"
      class="login-shader-canvas"
    />
    <div
      v-else
      class="login-shader-fallback"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.login-shader-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0f1722;
}
.login-shader-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.login-shader-fallback {
  position: absolute;
  inset: 0;
  background: linear-gradient(160deg, #0f1722 0%, #1b2940 100%);
}
</style>
