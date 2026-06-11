// Wallpaper — composes a shader with the login card centered over it.
// Used both inside small DCArtboards and in the focus overlay.

function Wallpaper({ shaderKey, compact = false, showCard = true, label }){
  const shader = window.SHADERS[shaderKey];
  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#0a0c10',
      overflow: 'hidden',
    }}>
      <window.ShaderCanvas frag={shader.frag} />

      {showCard && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <window.LoginCard compact={compact} />
        </div>
      )}

      {/* tiny chrome — name + interaction hint */}
      <div style={{
        position: 'absolute',
        top: compact ? 12 : 22,
        left: compact ? 14 : 26,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: compact ? 9 : 11,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.55)',
        mixBlendMode: 'difference',
        pointerEvents: 'none',
      }}>
        {label || shader.name}
      </div>
      <div style={{
        position: 'absolute',
        bottom: compact ? 12 : 22,
        right: compact ? 14 : 26,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: compact ? 8 : 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.45)',
        mixBlendMode: 'difference',
        pointerEvents: 'none',
        textAlign: 'right',
      }}>
        move · click<br/>
        <span style={{ opacity: 0.6 }}>{shader.blurb}</span>
      </div>
    </div>
  );
}

window.Wallpaper = Wallpaper;
