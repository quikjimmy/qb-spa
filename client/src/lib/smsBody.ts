// Splits an SMS / MMS body into ordered render parts so the UI can
// inline images and link out plain URLs without dumping a raw URL
// into a chat bubble.
//
// Detected URL kinds:
//   image — Dialpad's MMS CDN (content.dialpad.com/s/img/...) plus
//           common direct image extensions (jpg/png/gif/webp/heic).
//           Rendered as <img>.
//   link  — every other URL. Rendered as <a target="_blank">.
//   text  — everything in between. Preserves whitespace.
//
// The pattern is permissive so we don't blow up on URL fragments —
// extension/host check decides whether to treat as an image. URLs
// inside punctuation ("look at https://example.com.") still parse
// correctly because the trailing '.' isn't part of the matched URL
// when followed by whitespace or end-of-string.

export type MessagePart =
  | { kind: 'text'; value: string }
  | { kind: 'image'; url: string }
  | { kind: 'link'; url: string }

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi
const DIALPAD_IMG_HOST = /^https?:\/\/content\.dialpad\.com\/s\/img\//i
const IMG_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$|#)/i

export function isImageUrl(url: string): boolean {
  return DIALPAD_IMG_HOST.test(url) || IMG_EXT.test(url)
}

export function parseMessageBody(body: string | null | undefined): MessagePart[] {
  if (!body) return []
  const parts: MessagePart[] = []
  let lastIndex = 0
  // Reset regex state across calls.
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(body)) !== null) {
    const url = m[0]
    const start = m.index
    if (start > lastIndex) {
      const text = body.slice(lastIndex, start)
      if (text) parts.push({ kind: 'text', value: text })
    }
    parts.push(isImageUrl(url) ? { kind: 'image', url } : { kind: 'link', url })
    lastIndex = start + url.length
  }
  if (lastIndex < body.length) {
    const text = body.slice(lastIndex)
    if (text) parts.push({ kind: 'text', value: text })
  }
  return parts
}

// Convenience: does this body contain at least one inline image?
// Used to gate a wider bubble for image-heavy messages.
export function bodyHasImage(body: string | null | undefined): boolean {
  if (!body) return false
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(body)) !== null) {
    if (isImageUrl(m[0])) return true
  }
  return false
}
