// Five fragment shaders. Each draws a full-screen wallpaper that reacts to
// u_mouse (smoothed pointer 0..1), u_click (xyz: last click + seconds since),
// and u_pressed (1 while held).
//
// Palette references the brand:
//   warm off-white  vec3(0.957, 0.929, 0.894)
//   deep navy       vec3(0.086, 0.125, 0.180)
//   pale blue       vec3(0.898, 0.918, 0.961)
//   warm amber      vec3(0.957, 0.741, 0.439)

// ─────────────────────────────────────────────────────────────
// 1 · LIQUID MERCURY — slow flowing navy gradient with mouse wake.
//     Cursor leaves a glossy displacement trail. Click = ripple.
// ─────────────────────────────────────────────────────────────
const FRAG_MERCURY = window.SHADER_PRELUDE + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv;
  vec2 m = u_mouse;

  // base flow field — slow drift
  vec2 q = p * 1.6;
  q.x += 0.3 * sin(u_time*0.18) + fbm(p*1.5 + u_time*0.05);
  q.y += 0.3 * cos(u_time*0.22) + fbm(p*1.5 - u_time*0.04);
  float field = fbm(q + fbm(q*1.4));

  // mouse displacement — pull the field toward cursor
  vec2 d = p - m;
  float dist = length(d);
  float pull = 0.18 / (dist*4.0 + 0.25);
  field += pull * 0.35;

  // click ripple
  float r = length(p - u_click.xy);
  float ripple = sin(r*55.0 - u_click.z*9.0) * exp(-u_click.z*1.4) * exp(-r*5.0);
  field += ripple * 0.4;

  // banded gradient — mercury sheen
  float band = sin(field * 7.0 + u_time*0.3) * 0.5 + 0.5;
  band = smoothstep(0.0, 1.0, band);

  // map to brand: deep navy → pale steel blue
  vec3 navy   = vec3(0.060, 0.090, 0.140);
  vec3 mid    = vec3(0.180, 0.230, 0.330);
  vec3 sheen  = vec3(0.760, 0.820, 0.910);
  vec3 col = mix(navy, mid, smoothstep(0.0, 0.6, field));
  col = mix(col, sheen, smoothstep(0.6, 1.0, field) * 0.55);
  col += band * 0.05;

  // warm specular highlight near cursor
  float spec = exp(-dist*9.0);
  col += spec * vec3(0.25, 0.20, 0.14);

  // vignette
  float v = smoothstep(1.2, 0.4, length(uv-0.5));
  col *= 0.85 + 0.15*v;

  gl_FragColor = vec4(col, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// 2 · ARCHITECTURAL GRID — Kin glyph tessellation. The triangle/bar
//     motif from the logo tiled across the screen, gently parallaxing
//     to mouse. Click pulses a wave outward.
// ─────────────────────────────────────────────────────────────
const FRAG_GRID = window.SHADER_PRELUDE + `
// signed distance to the Kin glyph in a unit cell centered at 0.5
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,0.0)) + min(max(d.x,d.y), 0.0); }
float sdTri(vec2 p, float w, float h){
  // upward triangle outline approximation via two rotated boxes
  p.x = abs(p.x);
  float a = sdBox(p - vec2(w*0.5, 0.0), vec2(w*0.55, 0.06));
  // diagonal arms via rotation
  float ang = atan(h, w);
  mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 q = R * (p - vec2(0.0, 0.0));
  float arm = sdBox(q, vec2(0.55, 0.05));
  return min(a, arm);
}

float kinGlyph(vec2 p){
  // p in [-0.5, 0.5]
  float topBar = sdBox(p - vec2(0.0, 0.30), vec2(0.36, 0.05));
  float botBar = sdBox(p - vec2(0.0,-0.30), vec2(0.36, 0.05));
  float stem   = sdBox(p - vec2(0.0,-0.05), vec2(0.04, 0.30));
  // chevron — two angled bars
  vec2 q = p - vec2(0.0, 0.05);
  float ang = 0.55;
  mat2 RL = mat2(cos(ang),-sin(ang),sin(ang),cos(ang));
  mat2 RR = mat2(cos(-ang),-sin(-ang),sin(-ang),cos(-ang));
  float armL = sdBox(RL*(q + vec2(0.18,0.0)), vec2(0.22, 0.05));
  float armR = sdBox(RR*(q - vec2(0.18,0.0)), vec2(0.22, 0.05));
  return min(min(topBar, botBar), min(stem, min(armL, armR)));
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 asp = vec2(u_resolution.x/u_resolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp;

  // parallax + slow rotation toward mouse
  vec2 m = u_mouse - 0.5;
  p += m * 0.08;
  p = rot(0.04 * sin(u_time*0.2) + m.x*0.05) * p;

  // tile
  float scale = 7.0;
  vec2 cell = p * scale;
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5;

  // each tile sized differently in a checker-like way for rhythm
  float wob = 0.5 + 0.5*sin(id.x*1.3 + id.y*0.7 + u_time*0.4);
  float d = kinGlyph(f);

  // outline thickness pulses with click wave
  float clickR = length(p - (u_click.xy - 0.5)*asp);
  float wave = exp(-u_click.z*1.5) * smoothstep(0.05, 0.0, abs(clickR - u_click.z*0.9));
  float thick = 0.012 + 0.008*wob + wave*0.04;

  float glyph = smoothstep(thick, thick-0.006, d);

  // bg gradient — warm off-white with subtle tone
  vec3 bgA = vec3(0.957, 0.929, 0.894);
  vec3 bgB = vec3(0.918, 0.886, 0.843);
  vec3 bg = mix(bgA, bgB, smoothstep(0.0, 1.2, length(uv-vec2(0.5,0.3))));

  // glyph color — deep navy, with amber on the cell nearest the mouse
  vec2 mc = (m + 0.5) * scale * asp - vec2(scale*asp.x*0.5, scale*0.5);
  // per-tile distance to cursor
  vec2 cellCenter = (id + 0.5) / scale;
  float cd = length((cellCenter - 0.5)*asp - m*asp);
  float near = smoothstep(0.5, 0.0, cd);

  vec3 navy = vec3(0.086, 0.125, 0.180);
  vec3 amber = vec3(0.957, 0.741, 0.439);
  vec3 mark = mix(navy, amber, near*0.85);

  vec3 col = mix(bg, mark, glyph);

  // soft radial spotlight following cursor
  float sl = exp(-length(p - m*asp)*1.4) * 0.08;
  col += sl;

  gl_FragColor = vec4(col, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// 3 · WARM CAUSTICS — light through textured glass. Off-white scene
//     with shimmering caustic webbing. Mouse moves the light source.
//     Click = bright bloom.
// ─────────────────────────────────────────────────────────────
const FRAG_CAUSTICS = window.SHADER_PRELUDE + `
// classic caustic approximation via summed sines on warped uv
float caustic(vec2 p, float t){
  vec2 q = p;
  float v = 0.0;
  for (int i=0;i<4;i++){
    float fi = float(i);
    q = vec2(
      q.x + 0.6*sin(q.y*1.5 + t*0.6 + fi),
      q.y + 0.6*cos(q.x*1.5 + t*0.5 + fi*1.3)
    );
    v += 1.0 / (0.4 + abs(sin(q.x)) + abs(cos(q.y)));
  }
  return v / 6.0;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 asp = vec2(u_resolution.x/u_resolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp * 4.0;
  vec2 m = (u_mouse - 0.5) * asp * 4.0;

  // light source bias — caustics intensify near cursor
  vec2 lp = p - m*0.6;
  float c = caustic(lp, u_time*0.35);

  // click bloom
  vec2 cl = (u_click.xy - 0.5)*asp*4.0;
  float r = length(p - cl);
  float bloom = exp(-u_click.z*0.9) * exp(-r*0.7);

  // composition
  float light = pow(c, 1.6) * 0.55 + bloom*1.2;

  vec3 cream  = vec3(0.957, 0.929, 0.894);
  vec3 deep   = vec3(0.760, 0.690, 0.580);
  vec3 amber  = vec3(0.980, 0.800, 0.520);
  vec3 navyShadow = vec3(0.18, 0.20, 0.24);

  vec3 col = mix(navyShadow, cream, smoothstep(0.0, 0.45, light));
  col = mix(col, amber, smoothstep(0.45, 0.95, light)*0.7);
  col = mix(col, vec3(1.0,0.97,0.92), smoothstep(0.95, 1.4, light));

  // subtle paper grain
  float grain = (hash(uv*u_resolution.xy) - 0.5) * 0.025;
  col += grain;

  // edge falloff
  float v = smoothstep(1.4, 0.5, length(uv-0.5));
  col *= 0.9 + 0.1*v;

  gl_FragColor = vec4(col, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// 4 · TOPOGRAPHIC — contour lines like a site survey. Deep navy bg,
//     pale blue contours. Mouse warps the elevation field; click drops
//     a "pin" that pushes contours outward.
// ─────────────────────────────────────────────────────────────
const FRAG_TOPO = window.SHADER_PRELUDE + `
// SDF box helper used for the Kin glyph cursor mark
float sdBoxT(vec2 p, vec2 b){ vec2 d = abs(p)-b; return length(max(d,0.0)) + min(max(d.x,d.y), 0.0); }

// Kin glyph SDF — same construction as the architectural-grid shader.
// p is local space; "scale" controls the glyph size in p units.
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

  // base elevation field
  float e = fbm(p*2.4 + u_time*0.04);
  e += 0.6 * fbm(p*5.0 - u_time*0.03);

  // mouse "lifts" terrain — soft gaussian bump
  float md = length(p - m);
  e += 0.45 * exp(-md*md*5.0);

  // click "pin" — sharper, persistent-ish bump that fades
  vec2 cl = (u_click.xy - 0.5)*asp;
  float cd = length(p - cl);
  e += 0.6 * exp(-cd*cd*15.0) * exp(-u_click.z*0.6);

  // contour lines — fract of elevation, then thin band
  float lines = abs(fract(e * 9.0) - 0.5);
  float w = fwidth(e * 9.0);
  float contour = 1.0 - smoothstep(0.0, w*1.2, lines);

  // major contour every 5
  float majorLines = abs(fract(e * 1.8) - 0.5);
  float wm = fwidth(e * 1.8);
  float major = 1.0 - smoothstep(0.0, wm*1.5, majorLines);

  // colors
  vec3 bg     = vec3(0.060, 0.090, 0.140);
  vec3 bgHigh = vec3(0.110, 0.150, 0.220);
  vec3 line   = vec3(0.78, 0.84, 0.96);
  vec3 amber  = vec3(0.957, 0.741, 0.439);

  vec3 base = mix(bg, bgHigh, smoothstep(0.0, 1.5, e));
  vec3 col  = mix(base, line, contour*0.55);
  col = mix(col, amber, major*smoothstep(0.4, 0.0, md)*0.9); // amber contours near cursor
  col = mix(col, line, major*0.3);

  // Kin glyph cursor — replaces the crosshair. Sits at the cursor position,
  // amber on top of the contour field with a subtle outer halo.
  vec2 cp = p - m;
  float gscale = 0.055;
  float gd = kinGlyphT(cp, gscale);
  // halo ring just outside the glyph silhouette
  float halo = smoothstep(gscale*0.55, gscale*0.20, length(cp)) * 0.12;
  float glyphFill = smoothstep(0.002, 0.0, gd);
  // thin outline so it stays legible on light contour bands
  float glyphOutline = smoothstep(0.0028, 0.0014, abs(gd - 0.0008));
  col = mix(col, vec3(0.957, 0.741, 0.439), glyphFill);
  col = mix(col, vec3(0.060, 0.090, 0.140), glyphOutline*0.55);
  col += halo * vec3(0.957, 0.741, 0.439);

  // tiny markers at integer grid for site-plan feel
  vec2 g = fract(p*6.0)-0.5;
  float dot_ = smoothstep(0.04, 0.02, length(g));
  col += dot_ * 0.04;

  gl_FragColor = vec4(col, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// 5 · CRYSTAL VORONOI — facets of pale glass. Mouse moves the central
//     cell; click "shatters" — facets briefly displace outward.
// ─────────────────────────────────────────────────────────────
const FRAG_CRYSTAL = window.SHADER_PRELUDE + `
vec2 hash2(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// returns x: dist to nearest, y: dist to 2nd nearest, zw: nearest cell id
vec4 voronoi(vec2 x, float t){
  vec2 n = floor(x);
  vec2 f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  vec2 idBest = vec2(0.0);
  for (int j=-1;j<=1;j++){
    for (int i=-1;i<=1;i++){
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(n+g);
      o = 0.5 + 0.5*sin(t*0.6 + 6.2831*o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1){ d2 = d1; d1 = d; idBest = n+g; }
      else if (d < d2){ d2 = d; }
    }
  }
  return vec4(sqrt(d1), sqrt(d2), idBest);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 asp = vec2(u_resolution.x/u_resolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp;
  vec2 m = (u_mouse - 0.5) * asp;

  // shatter on click — push points outward briefly
  vec2 cl = (u_click.xy - 0.5)*asp;
  float shatter = exp(-u_click.z*1.6);
  vec2 push = normalize(p - cl + 0.0001) * shatter * 0.25;
  vec2 q = (p - push) * 4.0 + m*1.5;

  vec4 v = voronoi(q, u_time*0.3);
  float edge = v.y - v.x;       // distance to nearest edge
  float ew = fwidth(edge);
  float edgeMask = 1.0 - smoothstep(0.02, 0.02 + ew*2.0, edge);

  // per-cell tone
  float cellTone = fract(sin(dot(v.zw, vec2(12.9898, 78.233))) * 43758.5453);
  // facet brightness varies, like cut crystal
  float facet = mix(0.78, 1.0, cellTone);

  // distance from cursor to nearest cell — that one glows amber
  float md = length((v.zw + 0.5)/4.0 - m);
  float glow = smoothstep(0.8, 0.0, md);

  vec3 paleA = vec3(0.898, 0.918, 0.961);
  vec3 paleB = vec3(0.957, 0.929, 0.894);
  vec3 navy  = vec3(0.086, 0.125, 0.180);
  vec3 amber = vec3(0.957, 0.741, 0.439);

  vec3 base = mix(paleB, paleA, cellTone);
  base *= facet;
  base = mix(base, amber, glow*0.35);

  // edges — navy hairlines
  vec3 col = mix(base, navy, edgeMask*0.85);

  // gloss highlight that follows cursor
  float gloss = exp(-length(p - m)*2.5);
  col += gloss * vec3(0.18, 0.16, 0.12);

  // shatter flash
  col += shatter * 0.15 * vec3(1.0, 0.95, 0.88);

  gl_FragColor = vec4(col, 1.0);
}
`;

window.SHADERS = {
  mercury:  { name: 'Liquid Mercury',     frag: FRAG_MERCURY,  blurb: 'Brushed metal flow. Cursor drags a sheen, click ripples a wave.' },
  grid:     { name: 'Architectural Grid', frag: FRAG_GRID,     blurb: 'Mark of the brand, tiled. Cursor highlights the nearest cell.' },
  caustics: { name: 'Warm Caustics',      frag: FRAG_CAUSTICS, blurb: 'Light through textured glass. Cursor is the lamp.' },
  topo:     { name: 'Topographic',        frag: FRAG_TOPO,     blurb: 'Site survey contours. Cursor lifts elevation; click drops a pin.' },
  crystal:  { name: 'Crystal Facets',     frag: FRAG_CRYSTAL,  blurb: 'Cut-glass cells. Cursor warms the nearest facet; click shatters.' },
};
