// project-view.jsx — Kin Home Project Detail
// Mobile-first; same components scale up for desktop.
// Aesthetic: dark navy header, white cards on warm-beige bg, granular progress timeline.
// Exports to window: MobileProjectView, DesktopProjectView, ProjectData

const { useState, useEffect, useRef, useMemo } = React;

// ─────────────────────────────────────────────────────────────
// MOCK DATA — modeled after Kin Home Quickbase Projects table.
// ─────────────────────────────────────────────────────────────
const ProjectData = {
  id: 10621,
  customer: {
    name: 'Jaclynn Drummer',
    address: '2586 Alena Pl',
    city: 'Lake Mary, FL 32746',
    phone: '(407) 716-2292',
    email: 'JBSjoy@yahoo.com',
    outreachPref: 'SMS — unresponsive to email',
  },
  status: 'Active',
  daysInStage: 5,
  systemSize: 8.8,
  panels: 20,
  inverter: 'SolarEdge SE7600H-US',
  module: 'SEG-690-BTD-BG (DC)',
  estProduction: 13139,
  offset: 109.5,
  contractValue: 28072,
  grossPPW: 3.19,
  saleDate: '2026-04-27',
  ageDays: 1,
  closer: 'Blake Shirah',
  setter: 'Blake Shirah',
  areaDirector: 'Connor Free',
  coordinator: 'Emma Martin',
  lender: 'LightReach Finance',
  financeType: 'TPO · 25 yr · 0% APR',
  office: 'Elevate — Orlando East 2026',
  utility: 'Florida Power & Light (FPL)',
  ahj: 'Seminole County, Florida',
  utilityAccount: '05404-68501',
  starred: true,
  ntp: true, m1: true, m2: false, m3: false,
  // Granular progress timeline — what Kin really tracks.
  // status: done | active | pending
  progress: [
    { id: 'sale',         label: 'Sale Agreement',      date: 'Apr 27, 2026', status: 'done' },
    { id: 'ntp',          label: 'NTP Submitted',       date: 'Apr 27, 2026', status: 'done' },
    { id: 'kca',          label: 'KCA / Intake',        date: 'Apr 27, 2026', status: 'done' },
    { id: 'wcall',        label: 'Welcome Call',        date: 'Apr 27, 2026', status: 'done' },
    { id: 'srv-sch',      label: 'Survey Scheduled',    date: 'Apr 28, 2026', status: 'done' },
    { id: 'srv-sub',      label: 'Survey Submitted',    date: null,           status: 'active' },
    { id: 'srv-app',      label: 'Survey Approved',     date: null,           status: 'pending' },
    { id: 'cad-sub',      label: 'CAD Submitted',       date: null,           status: 'pending' },
    { id: 'cad-app',      label: 'CAD Approved',        date: null,           status: 'pending' },
    { id: 'eng-sub',      label: 'Engineering Submitted', date: null,         status: 'pending' },
    { id: 'design-done',  label: 'Design Completed',    date: null,           status: 'pending' },
    { id: 'permit-sub',   label: 'Permit Submitted',    date: null,           status: 'pending' },
    { id: 'permit-app',   label: 'Permit Approved',     date: null,           status: 'pending' },
    { id: 'nem-sub',      label: 'NEM Submitted',       date: null,           status: 'pending' },
    { id: 'nem-app',      label: 'NEM Approved',        date: null,           status: 'pending' },
    { id: 'inst-sch',     label: 'Install Scheduled',   date: null,           status: 'pending' },
    { id: 'inst-done',    label: 'Install Completed',   date: null,           status: 'pending' },
    { id: 'insp',         label: 'Inspection Passed',   date: null,           status: 'pending' },
    { id: 'pto-sub',      label: 'PTO Submitted',       date: null,           status: 'pending' },
    { id: 'pto-app',      label: 'PTO Approved',        date: null,           status: 'pending' },
  ],
  field: [
    { id: 'f1', kind: 'Site Survey',   status: 'Scheduled', date: 'Apr 29, 2026',
      crew: 'Arrivy · Christian Oquendo' },
    { id: 'f2', kind: 'Solar Install — Full Install', status: 'Tentative', date: 'Jun 6, 2026',
      crew: 'Central FL Crew · TBD' },
    { id: 'f3', kind: 'Final Inspection', status: 'Pending', date: '—',
      crew: 'Seminole County AHJ' },
  ],
  comms: [
    { id: 'c1', kind: 'sms', dir: 'in',  from: '(407) 716-2292', when: '9:42 AM',
      preview: 'YES, see you then.' },
    { id: 'c2', kind: 'sms', dir: 'out', from: '(407) 716-2292', when: 'Today',
      preview: 'Hi Jaclynn — confirming your site survey for Wed 4/29 at 12:30 PM. Reply YES to confirm.' },
    { id: 'c3', kind: 'call', dir: 'out', from: '(407) 716-2292', when: 'Apr 27',
      preview: 'Outgoing', dur: '4m 22s', rec: true },
    { id: 'c4', kind: 'sms', dir: 'out', from: '(407) 716-2292', when: 'Apr 27',
      preview: 'Welcome to Kin Home, Jaclynn! Your project ID is 10621. Emma will be your coordinator.' },
    { id: 'c5', kind: 'sms', dir: 'in',  from: '(407) 716-2292', when: 'Apr 27', tag: 'pending',
      preview: 'Received.' },
    { id: 'c6', kind: 'call', dir: 'in', from: '(407) 716-2292', when: 'Apr 27',
      preview: 'Incoming', dur: '1m 17s', rec: true },
  ],
  tickets: [
    { id: 'tk1', title: 'Customer back ID — Drivers License', state: 'Open',
      due: 'Due Apr 29, 2026', sub: 'Stipulation · Emma Martin · Task open', tone: 'open' },
    { id: 'tk2', title: 'Undersized System −1.2% — Confirm Offset', state: 'Pending',
      due: 'Due Apr 30, 2026', sub: 'Design · Manel Atienza · Task pending', tone: 'pending' },
  ],
  // ─── Deal Feed: every event in chronological order (newest first) ───
  feed: [
    { id: 'fd1',  ts: 'Today · 9:42 AM',   when: 'Today', kind: 'sms',     dir: 'in',
      who: 'Jaclynn Drummer', role: 'Customer',
      title: 'YES, see you then.', meta: 'Re: Site survey confirmation' },
    { id: 'fd2',  ts: 'Today · 9:36 AM',   when: 'Today', kind: 'sms',     dir: 'out',
      who: 'Emma Martin',      role: 'Coordinator',
      title: 'Hi Jaclynn — confirming your site survey for Wed 4/29 at 12:30 PM. Reply YES to confirm.' },
    { id: 'fd3',  ts: 'Today · 9:36 AM',   when: 'Today', kind: 'audit',
      who: 'Emma Martin',      role: 'Coordinator',
      title: 'Project Coordinator changed', body: 'Paige Elkins → Emma Martin' },
    { id: 'fd4',  ts: 'Apr 28 · 8:14 AM',  when: 'Apr 28', kind: 'field',
      who: 'Arrivy', role: 'Scheduling',
      title: 'Site Survey scheduled', body: 'Wed Apr 29 · 12:30 PM · Christian Oquendo' },
    { id: 'fd5',  ts: 'Apr 27 · 7:43 PM',  when: 'Apr 27', kind: 'system',
      who: 'Quickbase Admin', role: 'System',
      title: 'NEM record auto-assigned', body: 'Manel Atienza · based on Utility — FPL', category: 'NEM' },
    { id: 'fd6',  ts: 'Apr 27 · 7:06 PM',  when: 'Apr 27', kind: 'system',
      who: 'Quickbase Admin', role: 'System',
      title: 'Permit autoassigned',     body: 'lalaine.villegas@kinhome.com · Seminole County, Florida', category: 'Permitting' },
    { id: 'fd7',  ts: 'Apr 27 · 6:34 PM',  when: 'Apr 27', kind: 'note', pinned: true,
      who: 'Kimlee Paul Roje C.', role: 'Intake',
      title: 'Intake approved · moved to Active',
      body: 'All docs uploaded and stips cleared. Needs customer back ID. Consumption Audit done. Reject — Undersized System: −1.2%. Design Preferences and Rep Promises captured.',
      category: 'Intake' },
    { id: 'fd8',  ts: 'Apr 27 · 6:34 PM',  when: 'Apr 27', kind: 'milestone',
      who: 'System',
      title: 'Intake → Complete', body: '42 minutes in stage', category: 'Intake' },
    { id: 'fd9',  ts: 'Apr 27 · 6:13 PM',  when: 'Apr 27', kind: 'audit',
      who: 'Blake Shirah', role: 'Closer',
      title: 'Project Status changed', body: 'Pending KCA → Active' },
    { id: 'fd10', ts: 'Apr 27 · 5:51 PM',  when: 'Apr 27', kind: 'call', dir: 'out',
      who: 'Blake Shirah',  role: 'Closer',
      title: 'Welcome call', body: '4m 22s · Dialpad', meta: 'Outcome: Customer reached' },
    { id: 'fd11', ts: 'Apr 27 · 5:48 PM',  when: 'Apr 27', kind: 'doc',
      who: 'Blake Shirah',  role: 'Closer',
      title: '5 documents uploaded',
      body: 'Drivers License · IA · lightreach-ia · Proposed Design · 2× Utility Bill' },
    { id: 'fd12', ts: 'Apr 27 · 5:35 PM',  when: 'Apr 27', kind: 'milestone',
      who: 'System',
      title: 'NTP Submitted', body: 'LightReach Finance · 25-yr TPO · 0% APR' },
    { id: 'fd13', ts: 'Apr 27 · 5:30 PM',  when: 'Apr 27', kind: 'milestone',
      who: 'System',
      title: 'Project created',
      body: '8.8 kW · $28,072 · 2586 Alena Pl, Lake Mary FL', category: 'Sale' },
  ],
};

// ─────────────────────────────────────────────────────────────
// PALETTE — Kin Home colors (warm-beige bg, dark navy chrome)
// ─────────────────────────────────────────────────────────────
const C = {
  bg:        '#f4ede6',           // warm beige
  surface:   '#ffffff',
  surface2:  '#faf6f1',
  ink:       '#0f172a',           // navy-ink
  ink2:      '#1e293b',
  body:      '#334155',
  muted:     '#64748b',
  faint:     '#94a3b8',
  hairline:  '#e6dfd6',
  hairline2: '#d8cfc4',
  navy:      '#1d2a3d',           // header dark
  navy2:     '#2a3a52',
  ok:        '#16a34a',
  okSoft:    '#dcfce7',
  okText:    '#166534',
  warn:      '#b45309',
  warnSoft:  '#fef3c7',
  bad:       '#b91c1c',
  badSoft:   '#fee2e2',
  info:      '#0369a1',
  infoSoft:  '#e0f2fe',
  accent:    '#0f5132',           // Kin green for Active pill
  accentBg:  '#dcfce7',
  blue:      '#1d4ed8',
  blueSoft:  '#dbeafe',
  red:       '#dc2626',
  redSoft:   '#fee2e2',
  amber:     '#d97706',
};
const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif`;

// ─────────────────────────────────────────────────────────────
// CHROME — App header & primitives
// ─────────────────────────────────────────────────────────────
// Matches the existing Kin app chrome: thin grey breadcrumb bar + white page header.
// Adds an inline search affordance the user asked to keep from the prior pass.
function AppHeader({ title = 'Jaclynn Drummer - Jaclynn Drummer - 2586 Alena Pl', subtitle, mobile = false }) {
  return (
    <div style={{ flexShrink: 0, fontFamily: FONT, background: '#fff' }}>
      {/* Breadcrumb / utility strip */}
      <div style={{
        height: 36, background: '#f3f4f6', borderBottom: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px',
        fontSize: 12, color: '#374151',
      }}>
        <button style={breadBtn} aria-label="Home">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 11L12 4L21 11V20H14V14H10V20H3V11Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>
        </button>
        <span style={{ color: '#9ca3af' }}>›</span>
        <div style={{
          background: '#fff', border: '1px solid #d1d5db', borderRadius: 4,
          padding: '2px 8px', display: 'flex', flexDirection: 'column', lineHeight: 1.15,
        }}>
          <span style={{ fontWeight: 600, color: '#111827', fontSize: 12 }}>Projects ›</span>
          <span style={{ fontSize: 10, color: '#6b7280' }}>Reports › Settings</span>
        </div>
        {!mobile && (
          <span style={{ color: '#111827', fontWeight: 500, marginLeft: 4, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{title}</span>
        )}
        {mobile && <div style={{ flex: 1 }}/>}
        {/* search — kept from prior version */}
        <SearchBox mobile={mobile}/>
        {!mobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button style={pillBtnGreen}>+ New Project</button>
            <button style={pillBtnGhost}>✎ Edit</button>
            <button style={pillBtnGhost}>✉ Email</button>
            <button style={pillBtnGhost}>More ▾</button>
            <button style={pillBtnGhost}>⚙ Customize this Form</button>
          </div>
        )}
        {mobile && (
          <button style={breadBtn} aria-label="Menu">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 7H20M4 12H20M4 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>
      {/* Page title row — white, like the existing app */}
      {mobile && (
        <div style={{
          padding: '10px 14px 12px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'baseline', gap: 8,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', lineHeight: 1.25,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {title}
          </div>
          <span style={{ fontSize: 11, color: '#6b7280' }}>↶ Return</span>
        </div>
      )}
    </div>
  );
}
const breadBtn = {
  width: 24, height: 24, borderRadius: 4, background: 'transparent', color: '#374151',
  border: '1px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', padding: 0,
};
const pillBtnGreen = {
  background: '#16a34a', color: '#fff', border: '1px solid #15803d',
  borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'inherit',
};
const pillBtnGhost = {
  background: '#fff', color: '#374151', border: '1px solid #d1d5db',
  borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  fontFamily: 'inherit',
};

function SearchBox({ mobile }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  if (mobile) {
    return open ? (
      <div style={{
        position: 'absolute', left: 8, right: 8, top: 6, height: 24,
        display: 'flex', alignItems: 'center', gap: 6,
        background: '#fff', border: '1px solid #9ca3af', borderRadius: 4,
        padding: '0 8px', zIndex: 5,
      }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#6b7280" strokeWidth="2"/><path d="M20 20L17 17" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/></svg>
        <input autoFocus value={q} onChange={e=>setQ(e.target.value)}
          placeholder="Search projects, customers, addresses…"
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: 11, fontFamily: 'inherit', background: 'transparent', color: '#111827' }}/>
        <button onClick={()=>{ setOpen(false); setQ(''); }} style={{ ...breadBtn, fontSize: 14 }}>×</button>
      </div>
    ) : (
      <button style={breadBtn} onClick={()=>setOpen(true)} aria-label="Search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M20 20L17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
      </button>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: '#fff', border: '1px solid #d1d5db', borderRadius: 4,
      padding: '2px 8px', minWidth: 240,
    }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#6b7280" strokeWidth="2"/><path d="M20 20L17 17" stroke="#6b7280" strokeWidth="2" strokeLinecap="round"/></svg>
      <input value={q} onChange={e=>setQ(e.target.value)}
        placeholder="Search projects, customers, addresses…"
        style={{ flex: 1, border: 'none', outline: 'none', fontSize: 11, fontFamily: 'inherit', background: 'transparent', color: '#111827' }}/>
    </div>
  );
}

function StatusPill({ tone = 'ok', children, dot = false }) {
  const tones = {
    active: { bg: '#103929', fg: '#fff' },
    ok:     { bg: C.okSoft,   fg: C.okText },
    warn:   { bg: C.warnSoft, fg: C.warn },
    bad:    { bg: C.badSoft,  fg: C.bad },
    info:   { bg: C.infoSoft, fg: C.info },
    soft:   { bg: '#eef2f7',  fg: C.body },
    blue:   { bg: C.blueSoft, fg: C.blue },
    pending:{ bg: '#fde68a',  fg: '#92400e' },
    complete:{ bg: '#dcfce7',  fg: '#166534' },
  };
  const t = tones[tone] || tones.soft;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 999,
      background: t.bg, color: t.fg, fontFamily: FONT, fontWeight: 600, fontSize: 11,
      whiteSpace: 'nowrap',
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.fg, opacity: 0.9 }}/>}
      {children}
    </span>
  );
}

function Card({ children, padding = 16, style = {} }) {
  return (
    <div style={{
      background: C.surface, borderRadius: 14, padding,
      boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 1px 0 rgba(15,23,42,0.03)',
      ...style,
    }}>{children}</div>
  );
}

function CardHeader({ children, count, action, onAction }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '14px 16px 10px',
      fontFamily: FONT,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800, color: C.muted,
        letterSpacing: 1.2, textTransform: 'uppercase',
      }}>{children}</div>
      {count != null && (
        <span style={{
          background: '#eef2f7', color: C.body, fontWeight: 700, fontSize: 11,
          padding: '1px 7px', borderRadius: 999, minWidth: 18, textAlign: 'center',
        }}>{count}</span>
      )}
      <div style={{ flex: 1 }}/>
      {action && (
        <button onClick={onAction} style={{
          background: 'none', border: 'none', color: C.blue,
          fontFamily: FONT, fontWeight: 600, fontSize: 13, cursor: 'pointer',
        }}>{action}</button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CUSTOMER CARD (ops-facing — foregrounds blockers + SLA, then comms)
// ─────────────────────────────────────────────────────────────
function CustomerCard({ p }) {
  const Btn = ({ icon, label, color }) => (
    <button style={{
      flex: 1, height: 34, borderRadius: 8,
      background: '#f8fafc', border: `1px solid ${C.hairline}`,
      color: color, fontFamily: FONT, fontWeight: 700, fontSize: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
      cursor: 'pointer',
    }}>
      <span style={{ display: 'inline-flex' }}>{icon}</span>{label}
    </button>
  );
  const sla = p.daysInStage >= 5 ? { tone: 'warn', label: `${p.daysInStage}d in stage` } : { tone: 'soft', label: `${p.daysInStage}d in stage` };
  return (
    <Card padding={0} style={{ borderTop: `3px solid #103929` }}>
      <div style={{ padding: '14px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ fontSize: 18, color: C.faint, lineHeight: 1, marginTop: 2 }}>
            {p.starred ? '★' : '☆'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, fontFamily: FONT, letterSpacing: -0.2 }}>
                {p.customer.name}
              </div>
              <span style={{ fontSize: 12, color: C.muted, fontFamily: FONT, fontWeight: 600 }}>#{p.id}</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted, fontFamily: FONT, marginTop: 2 }}>
              {p.customer.address}, {p.customer.city}
            </div>
          </div>
          <StatusPill tone="active" dot>Active</StatusPill>
        </div>

        {/* Ops signal row: stage age + outreach pref + open blocker count */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <StatusPill tone={sla.tone}>⏱ {sla.label}</StatusPill>
          {p.tickets.length > 0 && <StatusPill tone="warn">⚠ {p.tickets.length} open stip</StatusPill>}
          <StatusPill tone="soft">📱 {p.customer.outreachPref}</StatusPill>
        </div>

        {/* Comms shortcuts (smaller — ops less likely to call than to view) */}
        <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
          <Btn color="#0f5132" icon={<Icon.Phone/>} label="Call" />
          <Btn color={C.blue} icon={<Icon.Chat/>} label="Text" />
          <Btn color={C.amber} icon={<Icon.Mail/>} label="Email" />
          <Btn color={C.red} icon={<Icon.Pin/>} label="Map" />
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// ICONS (small, monoline)
// ─────────────────────────────────────────────────────────────
const Icon = {
  Phone: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H9L11 9L8.5 10.5C9.6 12.7 11.3 14.4 13.5 15.5L15 13L20 15V19C20 19.6 19.6 20 19 20C12.4 20 4 11.6 4 5C4 4.4 4.4 4 5 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  Chat:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H19C20.1 4 21 4.9 21 6V15C21 16.1 20.1 17 19 17H8L4 21V6C4 4.9 4.9 4 5 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  Mail:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 8L12 14L21 8" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  Pin:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 22S5 14 5 9C5 5.1 8.1 2 12 2C15.9 2 19 5.1 19 9C19 14 12 22 12 22Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2"/></svg>,
  Cal:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 9H21M8 3V7M16 3V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  Ext:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M14 4H20V10M20 4L10 14M19 14V19C19 19.6 18.6 20 18 20H5C4.4 20 4 19.6 4 19V6C4 5.4 4.4 5 5 5H10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Bullet:({color}) => <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }}/>,
  Check: ({color = '#fff'}) => <svg width="9" height="9" viewBox="0 0 12 12"><path d="M2 6L5 9L10 3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>,
  CallSm: ({color}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H9L11 9L8.5 10.5C9.6 12.7 11.3 14.4 13.5 15.5L15 13L20 15V19C20 19.6 19.6 20 19 20C12.4 20 4 11.6 4 5C4 4.4 4.4 4 5 4Z" stroke={color} strokeWidth="2" strokeLinejoin="round"/></svg>,
  ChatSm:({color}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 4H19C20.1 4 21 4.9 21 6V15C21 16.1 20.1 17 19 17H8L4 21V6C4 4.9 4.9 4 5 4Z" stroke={color} strokeWidth="2" strokeLinejoin="round"/></svg>,
  Doc:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 3H6C4.9 3 4 3.9 4 5V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V9L14 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M14 3V9H20" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  Bell:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 8C6 5 8.7 3 12 3C15.3 3 18 5 18 8V13L20 16H4L6 13V8Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M10 19C10 20 11 21 12 21C13 21 14 20 14 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  Wrench:() => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 3C16.2 3 18 4.8 18 7C18 7.7 17.8 8.4 17.5 9L21 12.5L18 15.5L14.5 12C13.9 12.3 13.2 12.5 12.5 12.5C10.3 12.5 8.5 10.7 8.5 8.5L11 11L14 8L11 5L13 3.5C13.3 3.2 13.7 3 14 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
  Star:  ({filled}) => <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}><path d="M12 2L15 9L22 10L17 15L18 22L12 19L6 22L7 15L2 10L9 9L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>,
};

// ─────────────────────────────────────────────────────────────
// OPS SIGNAL — what does this project need RIGHT NOW
// ─────────────────────────────────────────────────────────────
function OpsSignal({ p }) {
  // Derive open work items from tickets + missing stips
  const items = [
    { sev: 'warn',   icon: '⚠', title: 'Customer back ID — Drivers License', who: 'Emma Martin', age: 'Due Apr 29' },
    { sev: 'info',   icon: '📐', title: 'Survey scheduled — confirm crew arrival', who: 'Christian O.', age: 'Tomorrow 12:30 PM' },
    { sev: 'warn',   icon: '⚡', title: 'Undersized System −1.2% — confirm offset',  who: 'Manel Atienza', age: 'Apr 30' },
    { sev: 'soft',   icon: '📋', title: 'NEM autoassigned — awaiting submission',     who: 'Manel Atienza', age: '4h' },
  ];
  const sevBg = { warn: '#fef3c7', info: '#dbeafe', soft: '#f1f5f9' };
  const sevFg = { warn: '#92400e', info: C.blue,    soft: C.body };
  return (
    <Card padding={0}>
      <CardHeader count={items.length}>What needs attention</CardHeader>
      <div style={{ padding: '0 16px 12px' }}>
        {items.map((it, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 0',
            borderBottom: i === items.length - 1 ? 'none' : `1px solid ${C.hairline}`,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, flexShrink: 0,
              background: sevBg[it.sev], color: sevFg[it.sev],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14,
            }}>{it.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: FONT, lineHeight: 1.35 }}>
                {it.title}
              </div>
              <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT, marginTop: 2 }}>
                {it.who} · {it.age}
              </div>
            </div>
            <button style={{
              background: 'none', border: 'none', color: C.blue,
              fontFamily: FONT, fontWeight: 600, fontSize: 12, cursor: 'pointer', flexShrink: 0,
            }}>Open →</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// SPECS GRID
// ─────────────────────────────────────────────────────────────
function SpecGrid({ p }) {
  const Cell = ({ label, children, sub, link }) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 1.1, textTransform: 'uppercase', fontFamily: FONT }}>{label}</div>
      <div style={{
        fontSize: 14, fontWeight: 700, color: link ? C.blue : C.ink,
        fontFamily: FONT, marginTop: 4, lineHeight: 1.3,
        display: 'flex', alignItems: 'center', gap: 4,
        textDecoration: link ? 'underline' : 'none',
      }}>
        {children}
        {link && <Icon.Ext/>}
      </div>
      {sub && <div style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
  const M = ({on, children}) => (
    <span style={{
      fontFamily: FONT, fontSize: 10, fontWeight: 800,
      padding: '2px 7px', borderRadius: 5,
      background: on ? '#103929' : '#e2e8f0',
      color: on ? '#fff' : C.muted, letterSpacing: 0.4,
    }}>{children}</span>
  );
  return (
    <Card padding={0}>
      <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 16px' }}>
        <Cell label="System Size">{p.systemSize} kW</Cell>
        <Cell label="Lender" sub={
          <div style={{ display: 'flex', gap: 4 }}>
            <M on={p.ntp}>NTP</M><M on={p.m1}>M1</M><M on={p.m2}>M2</M><M on={p.m3}>M3</M>
          </div>
        } link>
          <span style={{ color: C.blue }}>{p.lender}</span>
          <span style={{ marginLeft: 4, fontSize: 11 }}>🟧</span>
        </Cell>
        <Cell label="Sales Office">{p.office}</Cell>
        <Cell label="Closer">{p.closer}</Cell>
        <Cell label="Setter">{p.setter}</Cell>
        <Cell label="Coordinator">{p.coordinator}</Cell>
        <Cell label="Utility">{p.utility}</Cell>
        <Cell label="AHJ">{p.ahj}</Cell>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 1.1, textTransform: 'uppercase', fontFamily: FONT }}>Enerflo</div>
          <div style={{
            fontSize: 14, fontWeight: 700, color: C.ok, fontFamily: FONT, marginTop: 4,
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          }}>
            <Icon.Ext/> Open Project
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// NEXT-UP BANNER
// ─────────────────────────────────────────────────────────────
function NextUp({ p }) {
  const active = p.progress.find(x => x.status === 'active');
  if (!active) return null;
  return (
    <div style={{
      background: '#eff6ff', border: `1px solid #dbeafe`,
      borderRadius: 12, padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 12, fontFamily: FONT,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: '#dbeafe', color: C.blue,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 13,
      }}>
        <span style={{ fontSize: 12 }}>📅</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.blue, letterSpacing: 1.2, textTransform: 'uppercase' }}>
          Next Up
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginTop: 1 }}>
          {active.label} <span style={{ color: C.muted, fontWeight: 500 }}>· In progress</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PROGRESS TIMELINE — granular vertical list
// ─────────────────────────────────────────────────────────────
function ProgressTimeline({ items, expanded = false }) {
  const visible = expanded ? items : items.slice(0, 8);
  return (
    <Card padding={0}>
      <CardHeader>Progress Timeline</CardHeader>
      <div style={{ padding: '0 16px 14px' }}>
        {visible.map((m, i) => {
          const last = i === visible.length - 1;
          const dot = m.status === 'done'   ? { bg: C.ok,    border: C.ok,    glyph: <Icon.Check/> }
                    : m.status === 'active' ? { bg: '#fff',  border: C.ok,    ring: true }
                    :                          { bg: '#e2e8f0', border: '#e2e8f0' };
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, position: 'relative' }}>
              {/* line + dot column */}
              <div style={{ width: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <div style={{
                  width: 13, height: 13, borderRadius: '50%',
                  background: dot.bg, border: `2px solid ${dot.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: dot.ring ? `0 0 0 4px ${C.okSoft}` : 'none',
                  marginTop: 13, flexShrink: 0,
                }}>
                  {m.status === 'done' && <Icon.Check/>}
                </div>
                {!last && <div style={{ width: 1.5, flex: 1, background: '#e2e8f0', minHeight: 26 }}/>}
              </div>
              <div style={{
                flex: 1, padding: '11px 0',
                borderBottom: last ? 'none' : `1px solid ${C.hairline}`,
              }}>
                <div style={{
                  fontSize: 13, fontWeight: 700,
                  color: m.status === 'pending' ? C.faint : C.ink, fontFamily: FONT,
                }}>{m.label}</div>
                <div style={{
                  fontSize: 12, fontWeight: 500,
                  color: m.status === 'pending' ? C.faint : C.muted, fontFamily: FONT, marginTop: 2,
                }}>{m.date || (m.status === 'active' ? 'In progress' : 'Pending')}</div>
              </div>
            </div>
          );
        })}
        {!expanded && items.length > visible.length && (
          <div style={{ padding: '8px 0 0', textAlign: 'center' }}>
            <button style={{
              background: 'none', border: 'none', color: C.blue,
              fontFamily: FONT, fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}>See {items.length - visible.length} more steps</button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// FIELD ACTIVITY
// ─────────────────────────────────────────────────────────────
function FieldActivity({ items }) {
  const dotColor = (s) => s === 'Scheduled' ? C.blue : s === 'Approved' ? '#94d3a2' : s === 'Tentative' ? C.faint : '#cbd5e1';
  const tone     = (s) => s === 'Scheduled' ? 'blue' : s === 'Approved' ? 'complete' : s === 'Tentative' ? 'soft' : 'soft';
  return (
    <Card padding={0}>
      <CardHeader>Field Activity</CardHeader>
      <div style={{ padding: '0 16px 12px' }}>
        {items.map((f, i) => (
          <div key={f.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '11px 0',
            borderBottom: i === items.length - 1 ? 'none' : `1px solid ${C.hairline}`,
          }}>
            <div style={{ marginTop: 6 }}><Icon.Bullet color={dotColor(f.status)}/></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: FONT }}>{f.kind}</span>
                <StatusPill tone={tone(f.status)}>{f.status}</StatusPill>
              </div>
              <div style={{ fontSize: 12, color: C.muted, fontFamily: FONT, marginTop: 3 }}>
                {f.date} · {f.crew} <span style={{ color: C.blue, fontWeight: 600, marginLeft: 4, cursor: 'pointer' }}>View →</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// COMMUNICATIONS (with All / Calls / Texts segmented tabs)
// ─────────────────────────────────────────────────────────────
function Communications({ items }) {
  const [tab, setTab] = useState('all');
  const counts = {
    all:   items.length,
    calls: items.filter(c => c.kind === 'call').length,
    texts: items.filter(c => c.kind === 'sms').length,
  };
  const filtered = items.filter(c =>
    tab === 'all' ? true : tab === 'calls' ? c.kind === 'call' : c.kind === 'sms'
  );

  const Tab = ({ id, label, count }) => {
    const on = tab === id;
    return (
      <button onClick={() => setTab(id)} style={{
        flex: 1, height: 36, borderRadius: 8, border: 'none', cursor: 'pointer',
        background: on ? '#103929' : '#f1f5f9',
        color: on ? '#fff' : C.body,
        fontFamily: FONT, fontWeight: 700, fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        transition: 'all .15s',
      }}>
        {label}
        <span style={{
          background: on ? 'rgba(255,255,255,0.22)' : '#e2e8f0',
          color: on ? '#fff' : C.muted,
          fontWeight: 700, fontSize: 11,
          padding: '0 7px', height: 17, lineHeight: '17px', borderRadius: 999,
        }}>{count}</span>
      </button>
    );
  };

  return (
    <Card padding={0}>
      <CardHeader>Communications</CardHeader>
      <div style={{ padding: '0 12px 8px', display: 'flex', gap: 6 }}>
        <Tab id="all"   label="All"   count={counts.all}/>
        <Tab id="calls" label="Calls" count={counts.calls}/>
        <Tab id="texts" label="Texts" count={counts.texts}/>
      </div>
      <div style={{ padding: '4px 16px 12px' }}>
        {filtered.map((c, i) => (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '12px 0',
            borderBottom: i === filtered.length - 1 ? 'none' : `1px solid ${C.hairline}`,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: c.kind === 'call' ? '#dbeafe' : '#e0e7ff',
              color: c.kind === 'call' ? C.blue : '#4338ca',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {c.kind === 'call' ? <Icon.CallSm color="currentColor"/> : <Icon.ChatSm color="currentColor"/>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: FONT }}>{c.from}</span>
                <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>
                  {c.kind === 'call'
                    ? (c.dir === 'in' ? 'Incoming' : 'Outgoing')
                    : (c.dir === 'in' ? 'Received' : 'Sent')}
                </span>
                {c.dur && <StatusPill tone="soft">{c.dur}</StatusPill>}
                {c.rec && <StatusPill tone="info">REC</StatusPill>}
                {c.tag === 'pending' && <StatusPill tone="pending">pending</StatusPill>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: C.muted, fontFamily: FONT }}>{c.when}</span>
              </div>
              <div style={{
                fontSize: 13, color: C.body, fontFamily: FONT, marginTop: 3, lineHeight: 1.45,
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
              }}>{c.preview}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// TICKETS
// ─────────────────────────────────────────────────────────────
function Tickets({ items }) {
  return (
    <Card padding={0}>
      <CardHeader count={items.length}>Tickets</CardHeader>
      <div style={{ padding: '0 16px 14px' }}>
        {items.map((t, i) => {
          const accent = t.tone === 'open' ? C.amber : t.tone === 'pending' ? C.blue : C.ok;
          return (
            <div key={t.id} style={{
              borderLeft: `3px solid ${accent}`,
              paddingLeft: 12, padding: '10px 0 10px 12px',
              borderBottom: i === items.length - 1 ? 'none' : `1px solid ${C.hairline}`,
              marginLeft: -16, paddingRight: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontFamily: FONT, lineHeight: 1.3 }}>
                    {t.title} <span style={{ color: C.blue, fontWeight: 600, marginLeft: 4, cursor: 'pointer' }}>View →</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT, marginTop: 4 }}>{t.sub}</div>
                </div>
                <StatusPill tone={t.tone === 'open' ? 'pending' : t.tone === 'pending' ? 'blue' : 'complete'}>
                  {t.state}
                </StatusPill>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// DEAL FEED — single chronological view of EVERYTHING
// ─────────────────────────────────────────────────────────────
function DealFeed({ items }) {
  const [filter, setFilter] = useState('all');
  const filters = [
    { id: 'all',        label: 'All' },
    { id: 'note',       label: 'Notes' },
    { id: 'sms',        label: 'Texts' },
    { id: 'call',       label: 'Calls' },
    { id: 'milestone',  label: 'Milestones' },
    { id: 'audit',      label: 'Changes' },
    { id: 'system',     label: 'System' },
  ];
  const visible = filter === 'all' ? items : items.filter(x => x.kind === filter);

  // group by `when` label
  const groups = [];
  visible.forEach(it => {
    const key = it.when || 'Earlier';
    let g = groups.find(g => g.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(it);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Filter chip row */}
      <div style={{
        display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, marginBottom: 2,
        scrollbarWidth: 'none',
      }}>
        <style>{`.feed-chips::-webkit-scrollbar{display:none}`}</style>
        {filters.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            background: filter === f.id ? '#103929' : C.surface,
            color: filter === f.id ? '#fff' : C.body,
            border: filter === f.id ? 'none' : `1px solid ${C.hairline}`,
            borderRadius: 999, padding: '7px 14px',
            fontFamily: FONT, fontWeight: 600, fontSize: 12,
            cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
          }}>{f.label}</button>
        ))}
      </div>

      {groups.map(g => (
        <Card key={g.key} padding={0}>
          <div style={{
            padding: '12px 16px 8px', fontSize: 11, fontWeight: 800,
            color: C.muted, letterSpacing: 1.2, textTransform: 'uppercase',
            fontFamily: FONT,
            borderBottom: `1px solid ${C.hairline}`,
          }}>{g.key}</div>
          <div style={{ padding: '0 16px' }}>
            {g.items.map((it, i) => <FeedItem key={it.id} it={it} last={i === g.items.length - 1}/>)}
          </div>
        </Card>
      ))}

      {visible.length === 0 && (
        <Card padding={28}>
          <div style={{ textAlign: 'center', color: C.muted, fontFamily: FONT, fontSize: 13 }}>
            No items match this filter.
          </div>
        </Card>
      )}
    </div>
  );
}

function FeedItem({ it, last }) {
  // icon + accent per kind
  const k = {
    note:      { bg: '#fef3c7', fg: '#92400e', icon: <Icon.Doc/> , label: 'Note' },
    sms:       { bg: '#e0e7ff', fg: '#4338ca', icon: <Icon.ChatSm color="currentColor"/>, label: it.dir === 'in' ? 'Text · received' : 'Text · sent' },
    call:      { bg: '#dbeafe', fg: C.blue,    icon: <Icon.CallSm color="currentColor"/>, label: it.dir === 'in' ? 'Call · incoming' : 'Call · outgoing' },
    milestone: { bg: C.okSoft,   fg: C.okText, icon: <Icon.Check color="currentColor"/>,  label: 'Milestone' },
    audit:     { bg: '#f1f5f9', fg: C.body,    icon: <Icon.Wrench/>, label: 'Field changed' },
    system:    { bg: '#ede9fe', fg: '#6d28d9', icon: <Icon.Bell/>,   label: 'System' },
    doc:       { bg: '#fce7f3', fg: '#be185d', icon: <Icon.Doc/>,    label: 'Documents' },
    field:     { bg: '#dbeafe', fg: C.blue,    icon: <Icon.Cal/>,    label: 'Field' },
    email:     { bg: '#fef3c7', fg: C.amber,   icon: <Icon.Mail/>,   label: 'Email' },
  }[it.kind] || { bg: '#f1f5f9', fg: C.body, icon: <Icon.Doc/>, label: 'Event' };

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 11,
      padding: '12px 0',
      borderBottom: last ? 'none' : `1px solid ${C.hairline}`,
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
        background: k.bg, color: k.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{k.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: k.fg, textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: FONT }}>
            {k.label}
          </span>
          {it.category && <span style={{ fontSize: 10, color: C.muted, fontFamily: FONT, fontWeight: 600 }}>· {it.category}</span>}
          {it.pinned && <StatusPill tone="warn">📌 Pinned</StatusPill>}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.muted, fontFamily: FONT }}>{it.ts.split('·').pop().trim()}</span>
        </div>
        <div style={{
          fontSize: 13.5, fontWeight: 700, color: C.ink, fontFamily: FONT,
          marginTop: 3, lineHeight: 1.35,
        }}>{it.title}</div>
        {it.body && (
          <div style={{
            fontSize: 12.5, color: C.body, fontFamily: FONT,
            marginTop: 3, lineHeight: 1.45,
          }}>{it.body}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT, fontWeight: 600 }}>
            {it.who}{it.role && ` · ${it.role}`}
          </span>
          {it.meta && <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>· {it.meta}</span>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MOBILE PROJECT VIEW
// ─────────────────────────────────────────────────────────────
function MobileProjectView({ p = ProjectData, initialTab = 'overview' }) {
  const [tab, setTab] = useState(initialTab);
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'feed',     label: 'Deal Feed' },
    { id: 'progress', label: 'Progress' },
    { id: 'comms',    label: 'Comms' },
    { id: 'tickets',  label: 'Tickets', badge: p.tickets.length },
  ];
  return (
    <div style={{ width: '100%', height: '100%', background: C.bg,
      display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: FONT }}>
      <AppHeader mobile title="Jaclynn Drummer · 2586 Alena Pl"/>
      {/* Tab strip */}
      <div style={{
        background: '#fff', borderBottom: `1px solid ${C.hairline}`,
        padding: '8px 12px', display: 'flex', gap: 6, overflowX: 'auto',
        flexShrink: 0, scrollbarWidth: 'none',
      }}>
        <style>{`.mob-tabs::-webkit-scrollbar{display:none}`}</style>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? '#103929' : 'transparent',
            color: tab === t.id ? '#fff' : C.body,
            border: tab === t.id ? 'none' : `1px solid ${C.hairline}`,
            borderRadius: 999, padding: '6px 12px',
            fontFamily: FONT, fontWeight: 700, fontSize: 12,
            cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {t.label}
            {t.badge ? (
              <span style={{
                background: tab === t.id ? 'rgba(255,255,255,0.22)' : '#fee2e2',
                color: tab === t.id ? '#fff' : '#b91c1c',
                fontSize: 10, fontWeight: 800, padding: '0 6px', height: 16, lineHeight: '16px', borderRadius: 8,
              }}>{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {tab === 'overview' && (<>
            <CustomerCard p={p}/>
            <OpsSignal p={p}/>
            <NextUp p={p}/>
            <ProgressTimeline items={p.progress} expanded={false}/>
            <FieldActivity items={p.field}/>
            <SpecGrid p={p}/>
            <Communications items={p.comms}/>
            <Tickets items={p.tickets}/>
          </>)}

          {tab === 'feed' && (<>
            <CustomerCardCompact p={p}/>
            <DealFeed items={p.feed}/>
          </>)}

          {tab === 'progress' && (<>
            <CustomerCardCompact p={p}/>
            <NextUp p={p}/>
            <ProgressTimeline items={p.progress} expanded={true}/>
            <FieldActivity items={p.field}/>
          </>)}

          {tab === 'comms' && (<>
            <CustomerCardCompact p={p}/>
            <Communications items={p.comms}/>
          </>)}

          {tab === 'tickets' && (<>
            <CustomerCardCompact p={p}/>
            <Tickets items={p.tickets}/>
          </>)}
          <div style={{ height: 16 }}/>
        </div>
      </div>
    </div>
  );
}

// Compact customer card for non-overview tabs
function CustomerCardCompact({ p }) {
  return (
    <Card padding={0} style={{ borderTop: `3px solid #103929` }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, color: C.faint }}>{p.starred ? '★' : '☆'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: FONT }}>{p.customer.name}</div>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>
            #{p.id} · {p.systemSize} kW · {p.utility.split('(')[1]?.replace(')','') || p.utility}
          </div>
        </div>
        <StatusPill tone="active" dot>Active</StatusPill>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// DESKTOP — same components, 3-column layout
// ─────────────────────────────────────────────────────────────
function DesktopProjectView({ p = ProjectData }) {
  return (
    <div style={{ width: '100%', minHeight: '100%', background: C.bg, fontFamily: FONT }}>
      <AppHeader title="Jaclynn Drummer - Jaclynn Drummer - 2586 Alena Pl"/>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '20px 24px',
        display: 'grid', gridTemplateColumns: '360px 1fr 380px', gap: 18, alignItems: 'flex-start' }}>
        {/* Left rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <CustomerCard p={p}/>
          <SpecGrid p={p}/>
          <NextUp p={p}/>
        </div>
        {/* Center — Deal Feed (the "everything" view) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DealFeed items={p.feed}/>
        </div>
        {/* Right rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ProgressTimeline items={p.progress} expanded={true}/>
          <FieldActivity items={p.field}/>
          <Tickets items={p.tickets}/>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────
Object.assign(window, {
  MobileProjectView, DesktopProjectView, ProjectData,
});
