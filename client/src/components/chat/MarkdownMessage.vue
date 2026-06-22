<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/lib/markdown'

const props = defineProps<{ content: string }>()

// Memoized per message — only re-parses when this message's content changes.
const html = computed(() => renderMarkdown(props.content))
</script>

<template>
  <div class="md" v-html="html" />
</template>

<style scoped>
/* Compact markdown styling tuned for chat bubbles. Colours inherit from the
   bubble (foreground text) and use theme tokens for code/tables, so it stays
   correct in light and dark mode. Modeled on CommsHubSopView's .sop-doc rules
   but with tighter spacing for a conversational context. */
.md {
  font-size: inherit;
  line-height: inherit;
  color: inherit;
}
/* Collapse outer margins so the bubble padding stays even. */
.md :deep(> :first-child) { margin-top: 0; }
.md :deep(> :last-child) { margin-bottom: 0; }

.md :deep(p) { margin: 0.5em 0; }

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  font-weight: 600;
  line-height: 1.3;
  margin: 0.8em 0 0.4em;
}
.md :deep(h1) { font-size: 1.25em; letter-spacing: -0.01em; }
.md :deep(h2) { font-size: 1.12em; }
.md :deep(h3) { font-size: 1em; }
.md :deep(h4) { font-size: 0.95em; }

.md :deep(ul),
.md :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.35em;
}
.md :deep(li) { margin: 0.2em 0; }
.md :deep(li > p) { margin: 0.2em 0; }
.md :deep(ul) { list-style: disc; }
.md :deep(ol) { list-style: decimal; }

.md :deep(strong) { font-weight: 600; }
.md :deep(em) { font-style: italic; }

.md :deep(a) {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}

.md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  background: hsl(var(--muted));
  padding: 1px 5px;
  border-radius: 4px;
}
.md :deep(pre) {
  margin: 0.6em 0;
  padding: 10px 12px;
  background: hsl(var(--muted));
  border-radius: 10px;
  overflow-x: auto; /* wide code scrolls inside the bubble, never the page */
}
.md :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.85em;
}

.md :deep(table) {
  display: block;
  width: 100%;
  overflow-x: auto; /* wide tables scroll inside the bubble, never the page */
  border-collapse: collapse;
  margin: 0.6em 0;
  font-size: 0.9em;
}
.md :deep(th),
.md :deep(td) {
  text-align: left;
  padding: 5px 9px;
  border-bottom: 1px solid hsl(var(--border));
  vertical-align: top;
}
.md :deep(th) {
  font-weight: 600;
  font-size: 0.92em;
  color: hsl(var(--muted-foreground));
}

.md :deep(blockquote) {
  margin: 0.6em 0;
  padding: 0 0 0 12px;
  border-left: 3px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
}
.md :deep(hr) {
  border: 0;
  border-top: 1px solid hsl(var(--border));
  margin: 1em 0;
}
.md :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
</style>
