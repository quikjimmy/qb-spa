// ShaderCanvas — a tiny WebGL host that takes a fragment shader source and
// pumps in u_time / u_resolution / u_mouse / u_click uniforms.
// All five wallpapers consume this so they share the same plumbing.

const SHADER_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

function ShaderCanvas({ frag, width, height, onPointer, paused = false, style }) {
  const canvasRef = React.useRef(null);
  const stateRef = React.useRef({
    mouse: [0.5, 0.5],
    target: [0.5, 0.5],
    click: [0.5, 0.5, 0],   // x, y, time-of-click
    pressed: 0,
  });

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false });
    if (!gl) return;
    gl.getExtension('OES_standard_derivatives');

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('shader compile error:', gl.getShaderInfoLog(s), src);
      }
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, SHADER_VS);
    const fs = compile(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_resolution');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');
    const uClick = gl.getUniformLocation(prog, 'u_click');
    const uPressed = gl.getUniformLocation(prog, 'u_pressed');

    function resize() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const t0 = performance.now();
    let raf = 0;
    function frame() {
      const t = (performance.now() - t0) / 1000;
      // ease mouse toward target
      const s = stateRef.current;
      s.mouse[0] += (s.target[0] - s.mouse[0]) * 0.08;
      s.mouse[1] += (s.target[1] - s.mouse[1]) * 0.08;

      gl.uniform1f(uTime, t);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uMouse, s.mouse[0], s.mouse[1]);
      gl.uniform3f(uClick, s.click[0], s.click[1], t - s.click[2]);
      gl.uniform1f(uPressed, s.pressed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    }
    if (!paused) raf = requestAnimationFrame(frame);

    function ptr(e) {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = 1 - (e.clientY - r.top) / r.height;
      stateRef.current.target = [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
      onPointer && onPointer({ x, y });
    }
    function down(e) {
      ptr(e);
      const t = (performance.now() - t0) / 1000;
      stateRef.current.click = [stateRef.current.target[0], stateRef.current.target[1], t];
      stateRef.current.pressed = 1;
    }
    function up() { stateRef.current.pressed = 0; }
    canvas.addEventListener('pointermove', ptr);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', ptr);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', up);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [frag, paused]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: width || '100%', height: height || '100%', touchAction: 'none', ...style }}
    />
  );
}

// Common GLSL prelude shared by all shaders.
const SHADER_PRELUDE = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;     // 0..1
uniform vec3  u_click;     // xy=last click, z=time since click
uniform float u_pressed;   // 1 while pointer held

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
`;

window.ShaderCanvas = ShaderCanvas;
window.SHADER_PRELUDE = SHADER_PRELUDE;
