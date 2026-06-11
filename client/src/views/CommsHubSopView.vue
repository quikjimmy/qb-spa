<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { marked } from 'marked'
import sopMd from '@/content/comms-hub-sops.md?raw'
import { Button } from '@/components/ui/button'

// Rendered once per mount — the source markdown is bundled, so no
// network fetch and no need to re-parse on prop changes.
const html = computed(() => marked.parse(sopMd, { gfm: true, breaks: false }) as string)

const router = useRouter()
function back() {
  if (window.history.length > 1) router.back()
  else router.push({ name: 'comms' })
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10">
    <div class="flex items-center justify-between mb-6">
      <Button variant="ghost" size="sm" @click="back">← Back</Button>
      <p class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Comms Hub · SOP</p>
    </div>
    <article class="sop-doc" v-html="html" />
  </div>
</template>

<style scoped>
.sop-doc {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  color: hsl(var(--foreground));
  line-height: 1.65;
  font-size: 15px;
}
.sop-doc :deep(h1) {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 24px;
  line-height: 1.2;
}
.sop-doc :deep(h2) {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 36px 0 12px;
  line-height: 1.3;
  padding-top: 16px;
  border-top: 1px solid hsl(var(--border));
}
.sop-doc :deep(h2:first-of-type) {
  border-top: none;
  padding-top: 0;
  margin-top: 24px;
}
.sop-doc :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 24px 0 8px;
  line-height: 1.4;
}
.sop-doc :deep(p) {
  margin: 12px 0;
}
.sop-doc :deep(ul),
.sop-doc :deep(ol) {
  margin: 12px 0;
  padding-left: 24px;
}
.sop-doc :deep(li) {
  margin: 6px 0;
}
.sop-doc :deep(li > p) {
  margin: 4px 0;
}
.sop-doc :deep(strong) {
  font-weight: 600;
}
.sop-doc :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  background: hsl(var(--muted));
  color: hsl(var(--foreground));
  padding: 1px 6px;
  border-radius: 4px;
}
.sop-doc :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 14px;
  display: block;
  overflow-x: auto;
}
.sop-doc :deep(thead) {
  background: hsl(var(--muted));
}
.sop-doc :deep(th),
.sop-doc :deep(td) {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid hsl(var(--border));
  vertical-align: top;
}
.sop-doc :deep(th) {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: hsl(var(--muted-foreground));
}
.sop-doc :deep(blockquote) {
  margin: 16px 0;
  padding: 0 16px;
  border-left: 3px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
}
.sop-doc :deep(hr) {
  border: 0;
  border-top: 1px solid hsl(var(--border));
  margin: 32px 0;
}
.sop-doc :deep(a) {
  color: hsl(var(--primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
