// Normalize phone-number strings into a canonical E.164-style key for
// joins. We intentionally keep this simple — the goal is "two strings
// that represent the same number compare equal", not full-fidelity
// E.164 parsing.
//
// Behavior:
//   - Strip everything except digits and a leading '+'.
//   - Drop a leading '+'; we store digits only.
//   - 10-digit US numbers get a leading '1' prepended.
//   - 11-digit numbers starting with 1 are kept as-is.
//   - Anything else is passed through (international, short codes, etc).
//
// Returns '' for empty/unparseable input.

export function canonicalPhone(input: string | null | undefined): string {
  if (!input) return ''
  // Strip "tel:" prefix that some Dialpad payloads carry.
  const cleaned = String(input).trim().replace(/^tel:/i, '')
  // Keep digits only.
  const digits = cleaned.replace(/[^0-9]/g, '')
  if (!digits) return ''
  // 10-digit US — assume +1.
  if (digits.length === 10) return '1' + digits
  // 11-digit starting with 1 — already canonical.
  if (digits.length === 11 && digits.startsWith('1')) return digits
  // Anything else — leave it. Could be int'l or short code.
  return digits
}

// E.164 with leading '+'. Dialpad's contacts/calls APIs require this exact
// shape; canonicalPhone() above returns digits-only for join keys.
export function toE164(input: string | null | undefined): string {
  if (!input) return ''
  const raw = String(input).trim().replace(/^tel:/i, '')
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (raw.startsWith('+')) return '+' + digits
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
  return '+' + digits
}
