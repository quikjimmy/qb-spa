// LoginCard — sits on top of every shader artboard so the user sees the real
// premium-experience context. Glass-morphic card; uses the brand's existing
// "Welcome back / Sign in to the Kin Home Portal" copy as a placeholder.
//
// `compact` shrinks it for the small artboard view; on the focus overlay
// we render full-size.

function KinGlyph({ size = 28, color = '#16202E' }){
  // Recreates the geometric mark: top bar, bottom bar, vertical stem,
  // chevron arms. Built from rectangles to match the brand's hard-edge feel.
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="14" y="22" width="72" height="10" fill={color}/>
      <rect x="14" y="68" width="72" height="10" fill={color}/>
      <rect x="46" y="40" width="8" height="32" fill={color}/>
      <polygon points="50,32 22,62 22,52 50,22" fill={color}/>
      <polygon points="50,32 78,62 78,52 50,22" fill={color}/>
    </svg>
  );
}

function LoginCard({ compact = false, accent = '#16202E', tone = 'light' }){
  const dark = tone === 'dark';
  const bg = dark ? 'rgba(22,32,46,0.72)' : 'rgba(255,253,250,0.82)';
  const stroke = dark ? 'rgba(255,255,255,0.08)' : 'rgba(22,32,46,0.06)';
  const text = dark ? '#F4EDE4' : '#16202E';
  const sub = dark ? 'rgba(244,237,228,0.62)' : 'rgba(22,32,46,0.55)';
  const inputBg = dark ? 'rgba(255,255,255,0.06)' : 'rgba(229,234,245,0.85)';
  const btnBg = dark ? '#F4EDE4' : '#16202E';
  const btnText = dark ? '#16202E' : '#F4EDE4';

  const scale = compact ? 0.72 : 1;
  return (
    <div style={{
      width: 380 * scale,
      padding: `${36*scale}px ${36*scale}px ${28*scale}px`,
      background: bg,
      backdropFilter: 'blur(22px) saturate(1.1)',
      WebkitBackdropFilter: 'blur(22px) saturate(1.1)',
      border: `1px solid ${stroke}`,
      borderRadius: 18 * scale,
      boxShadow: '0 30px 80px -30px rgba(0,0,0,0.45), 0 8px 30px -10px rgba(0,0,0,0.25)',
      color: text,
      fontFamily: '"Inter Tight", "Inter", system-ui, sans-serif',
      pointerEvents: 'none',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24*scale }}>
        <KinGlyph size={26*scale} color={text} />
        <div style={{ fontSize: 13*scale, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 600 }}>
          Kin Home · Ope
        </div>
      </div>

      <div style={{ fontSize: 30*scale, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6*scale }}>
        Welcome back
      </div>
      <div style={{ fontSize: 14*scale, color: sub, marginBottom: 22*scale }}>
        Sign in to continue your shift.
      </div>

      <Field label="Email" value="james@kinhome.com" {...{ inputBg, sub, text, scale }}/>
      <Field label="Password" value="••••••••••••" {...{ inputBg, sub, text, scale, mt: 14*scale }}/>

      <div style={{
        marginTop: 22*scale,
        height: 46*scale,
        background: btnBg,
        color: btnText,
        borderRadius: 10*scale,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 600, fontSize: 14*scale, letterSpacing: '0.02em',
      }}>
        Sign in
      </div>

      <div style={{
        marginTop: 16*scale, textAlign: 'center', fontSize: 12*scale, color: sub,
      }}>
        Need access? <span style={{ color: text, borderBottom: `1px solid ${text}`, paddingBottom: 1 }}>Request an invite</span>
      </div>
    </div>
  );
}

function Field({ label, value, inputBg, sub, text, scale, mt = 0 }){
  return (
    <div style={{ marginTop: mt }}>
      <div style={{ fontSize: 11*scale, color: sub, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6*scale, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{
        height: 42*scale,
        background: inputBg,
        borderRadius: 10*scale,
        display: 'flex', alignItems: 'center',
        padding: `0 ${14*scale}px`,
        fontSize: 14*scale,
        color: text,
      }}>
        {value}
      </div>
    </div>
  );
}

window.LoginCard = LoginCard;
window.KinGlyph = KinGlyph;
