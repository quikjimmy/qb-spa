// Initials avatars for note authors — tone is hashed from the name so
// the same person always renders the same calm tint, everywhere.
const AVATAR_TONES = [
  { bg: '#ccfbf1', fg: '#115e59' },  // teal
  { bg: '#e0e7ff', fg: '#3730a3' },  // indigo
  { bg: '#fce7f3', fg: '#9d174d' },  // pink
  { bg: '#ede9fe', fg: '#5b21b6' },  // violet
  { bg: '#dcfce7', fg: '#166534' },  // green
]

export function initials(name?: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'N'
  const first = parts[0]?.charAt(0) ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''
  return (first + last).toUpperCase() || 'N'
}

export function avatarTone(name?: string | null): { bg: string; fg: string } {
  const s = (name ?? '').trim()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length]!
}
