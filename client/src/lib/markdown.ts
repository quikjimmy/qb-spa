// Markdown → safe HTML for chat / AI-generated content.
//
// `marked` turns markdown into HTML; `DOMPurify` strips anything dangerous.
// Assistant replies are LLM/agent output (and can be prompt-injected via the
// QuickBase notes/comms the agent reads), so we never trust the raw HTML —
// always sanitize before binding with v-html.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Open links in a new tab, safely. Registered once at module load (this module
// is a singleton, so the hook is added a single time regardless of how many
// components import renderMarkdown).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// gfm: tables/strikethrough etc. breaks: single newline → <br>, matching the
// "newlines matter" feel users expect in a chat bubble.
export function renderMarkdown(src: string | null | undefined): string {
  const html = marked.parse(src ?? '', { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(html)
}
