<script setup lang="ts">
import { computed } from 'vue'
import type { Hero } from '@/lib/feedHero'

const props = defineProps<{
  hero: Hero
  title: string
  projectId: number | null
  projectName: string | null
}>()

const emit = defineEmits<{ 'open-project': [projectId: number] }>()

const toneClass = computed(() =>
  props.hero.tone === 'scheduled' ? 'hero--airy' : props.hero.tone === 'attention' ? 'hero--attn' : '',
)

// Sparks celebrate the two biggest moments: PTO (system live) and a
// completed install.
const showSparks = computed(() =>
  props.hero.family === 'pto' || (props.hero.family === 'install' && props.hero.tone === 'celebration'),
)
</script>

<template>
  <div class="hero-scene sm:rounded-2xl overflow-hidden p-8 flex flex-col justify-center items-center text-center min-h-[210px] relative" :class="[`hero-${hero.family}`, toneClass]">
    <!-- Drifting light orbs (all scenes) -->
    <div class="orb orb-a" aria-hidden="true" />
    <div class="orb orb-b" aria-hidden="true" />

    <!-- Per-family accent layers -->
    <div v-if="hero.family === 'survey'" class="sun" aria-hidden="true" />
    <div v-if="hero.family === 'design'" class="blueprint" aria-hidden="true" />
    <div v-if="hero.family === 'install' || hero.family === 'pto'" class="rays" aria-hidden="true" />
    <div v-if="hero.family === 'inspection'" class="beam" aria-hidden="true" />
    <svg v-if="hero.family === 'nem'" class="pulse" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 30 L120 30 L140 12 L165 48 L185 30 L400 30" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" />
    </svg>
    <template v-if="showSparks">
      <span class="spark s1" aria-hidden="true" /><span class="spark s2" aria-hidden="true" />
      <span class="spark s3" aria-hidden="true" /><span class="spark s4" aria-hidden="true" />
    </template>

    <!-- Ghost watermark icon (floats gently) -->
    <svg class="hero-ghost" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="hero.icon" /></svg>

    <!-- Content -->
    <span class="hero-chip relative z-10 inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest text-white/90 mb-4">{{ hero.kicker }}</span>
    <h3 class="relative z-10 text-2xl sm:text-3xl font-black text-white tracking-tight leading-tight">{{ title }}</h3>
    <p v-if="hero.subtitle" class="relative z-10 text-white/60 text-[11px] font-bold uppercase tracking-widest mt-2">{{ hero.subtitle }}</p>
    <button
      v-if="projectName && projectId"
      class="relative z-10 inline-flex items-center gap-1 text-white/80 text-sm font-semibold mt-2 underline decoration-white/40 underline-offset-4 hover:text-white hover:decoration-white transition-colors cursor-pointer"
      :title="`Quick view: ${projectName}`"
      @click="emit('open-project', projectId)"
    >
      {{ projectName }}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>
    </button>
    <p v-else-if="projectName" class="relative z-10 text-white/70 text-sm font-medium mt-2">{{ projectName }}</p>
    <p v-if="hero.dateLine" class="hero-chip relative z-10 text-white text-xs font-bold mt-4 px-3.5 py-1.5 rounded-full">{{ hero.dateLine }}</p>
  </div>
</template>

<style scoped>
/* ── Living hero scenes ─────────────────────────────────────
   Each family gets a base linear gradient plus animated layers:
   two slow-drifting blurred orbs everywhere, then a family accent —
   rising sun (survey), panning blueprint grid (design), rotating rays
   (install/PTO), sweeping beam (inspection), energy pulse (NEM),
   twinkling sparks (PTO). Everything animates transform/opacity only
   (compositor-friendly) on 7–90s loops — alive, never busy.
   prefers-reduced-motion freezes the lot. */

.hero-scene { isolation: isolate; }

/* Film grain */
.hero-scene::after {
  content: '';
  position: absolute; inset: 0; z-index: 2;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E");
  pointer-events: none;
}

/* Drifting orbs — colors set per family via CSS vars */
.orb {
  position: absolute; z-index: 0;
  width: 320px; height: 320px; border-radius: 50%;
  filter: blur(36px);
  will-change: transform;
  pointer-events: none;
}
.orb-a {
  top: -120px; left: -80px;
  background: radial-gradient(circle at center, var(--orb-a) 0%, transparent 65%);
  animation: drift-a 19s ease-in-out infinite alternate;
}
.orb-b {
  bottom: -140px; right: -90px;
  background: radial-gradient(circle at center, var(--orb-b) 0%, transparent 65%);
  animation: drift-b 23s ease-in-out infinite alternate;
}
@keyframes drift-a {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(60px, 34px) scale(1.18); }
}
@keyframes drift-b {
  from { transform: translate(0, 0) scale(1.1); }
  to { transform: translate(-70px, -30px) scale(0.92); }
}

/* Ghost icon floats */
.hero-ghost {
  position: absolute; right: -28px; bottom: -32px; z-index: 1;
  width: 190px; height: 190px;
  color: #fff; opacity: 0.1;
  animation: ghost-float 9s ease-in-out infinite alternate;
  pointer-events: none;
}
@keyframes ghost-float {
  from { transform: rotate(-8deg) translateY(0); }
  to { transform: rotate(-5deg) translateY(-10px); }
}

.hero-chip {
  background: rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ── Family accents ── */

/* Survey: a low sun slowly rising through dawn haze */
.sun {
  position: absolute; z-index: 0; left: 14%; bottom: -70px;
  width: 200px; height: 200px; border-radius: 50%;
  background: radial-gradient(circle at center, rgba(253, 186, 116, 0.85) 0%, rgba(253, 186, 116, 0.25) 45%, transparent 70%);
  filter: blur(10px);
  animation: sunrise 16s ease-in-out infinite alternate;
  will-change: transform;
  pointer-events: none;
}
@keyframes sunrise {
  from { transform: translateY(26px) scale(0.96); }
  to { transform: translateY(-14px) scale(1.06); }
}

/* Design: blueprint grid panning diagonally */
.blueprint {
  position: absolute; z-index: 0; inset: -60%;
  background-image:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.09) 0 1px, transparent 1px 36px),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.09) 0 1px, transparent 1px 36px);
  animation: grid-pan 40s linear infinite;
  pointer-events: none;
}
@keyframes grid-pan {
  from { transform: translate(0, 0); }
  to { transform: translate(72px, 72px); }
}

/* Install / PTO: sun rays rotating almost imperceptibly */
.rays {
  position: absolute; z-index: 0; left: 50%; top: 50%;
  width: 720px; height: 720px; margin: -360px 0 0 -360px;
  background: repeating-conic-gradient(rgba(255, 255, 255, 0.07) 0deg 9deg, transparent 9deg 26deg);
  border-radius: 50%;
  animation: rays-spin 90s linear infinite;
  will-change: transform;
  pointer-events: none;
}
@keyframes rays-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Inspection: a soft scanning beam sweeping through */
.beam {
  position: absolute; z-index: 1; top: -20%; bottom: -20%; left: 0;
  width: 90px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.14), transparent);
  transform: translateX(-140px) skewX(-14deg);
  animation: beam-sweep 8s ease-in-out infinite;
  pointer-events: none;
}
@keyframes beam-sweep {
  0% { transform: translateX(-140px) skewX(-14deg); }
  45% { transform: translateX(700px) skewX(-14deg); }
  100% { transform: translateX(700px) skewX(-14deg); }
}

/* NEM: an energy pulse tracing the line */
.pulse {
  position: absolute; z-index: 1; left: 0; right: 0; bottom: 26%;
  width: 100%; height: 60px;
  pointer-events: none;
}
.pulse path {
  stroke-dasharray: 90 600;
  stroke-dashoffset: 690;
  animation: pulse-run 4.5s linear infinite;
}
@keyframes pulse-run {
  to { stroke-dashoffset: 0; }
}

/* PTO: sparks twinkling */
.spark {
  position: absolute; z-index: 1;
  width: 5px; height: 5px; border-radius: 50%;
  background: #fff;
  opacity: 0;
  animation: twinkle 3.6s ease-in-out infinite;
  pointer-events: none;
}
.s1 { top: 22%; left: 16%; animation-delay: 0s; }
.s2 { top: 14%; right: 24%; animation-delay: 1.1s; }
.s3 { bottom: 26%; left: 30%; animation-delay: 2s; }
.s4 { top: 38%; right: 12%; animation-delay: 2.8s; }
@keyframes twinkle {
  0%, 100% { opacity: 0; transform: scale(0.5); }
  50% { opacity: 0.9; transform: scale(1.25); }
}

/* ── Family palettes: base gradient + orb colors ── */
.hero-survey {
  --orb-a: rgba(253, 186, 116, 0.5); --orb-b: rgba(67, 56, 202, 0.6);
  background: linear-gradient(135deg, #0ea5e9 0%, #4f46e5 100%);
}
.hero-design {
  --orb-a: rgba(217, 70, 239, 0.45); --orb-b: rgba(34, 211, 238, 0.3);
  background: linear-gradient(135deg, #7c3aed 0%, #312e81 100%);
}
.hero-permit {
  --orb-a: rgba(254, 243, 199, 0.4); --orb-b: rgba(120, 53, 15, 0.55);
  background: linear-gradient(135deg, #f59e0b 0%, #b45309 100%);
}
.hero-nem {
  --orb-a: rgba(34, 211, 238, 0.45); --orb-b: rgba(8, 51, 68, 0.6);
  background: linear-gradient(135deg, #0d9488 0%, #155e75 100%);
}
.hero-install {
  --orb-a: rgba(253, 224, 71, 0.42); --orb-b: rgba(159, 18, 57, 0.6);
  background: linear-gradient(135deg, #f97316 0%, #be123c 100%);
}
.hero-inspection {
  --orb-a: rgba(96, 165, 250, 0.42); --orb-b: rgba(15, 23, 42, 0.55);
  background: linear-gradient(135deg, #4338ca 0%, #1e1b4b 100%);
}
.hero-pto {
  --orb-a: rgba(255, 255, 255, 0.3); --orb-b: rgba(250, 204, 21, 0.38);
  background: linear-gradient(135deg, #059669 0%, #0f766e 100%);
}
.hero-status {
  --orb-a: rgba(125, 211, 252, 0.32); --orb-b: rgba(15, 23, 42, 0.5);
  background: linear-gradient(135deg, #475569 0%, #1e293b 100%);
}
.hero-note {
  --orb-a: rgba(254, 240, 138, 0.42); --orb-b: rgba(154, 52, 18, 0.45);
  background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);
}
.hero-ticket {
  --orb-a: rgba(251, 207, 232, 0.36); --orb-b: rgba(76, 5, 25, 0.5);
  background: linear-gradient(135deg, #9f1239 0%, #831843 100%);
}
.hero-task {
  --orb-a: rgba(196, 181, 253, 0.4); --orb-b: rgba(49, 46, 129, 0.5);
  background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
}
.hero-agent {
  --orb-a: rgba(165, 243, 252, 0.4); --orb-b: rgba(30, 58, 138, 0.5);
  background: linear-gradient(135deg, #0891b2 0%, #1d4ed8 100%);
}

/* ── Tone modifiers ── */
.hero--airy { filter: brightness(1.1) saturate(0.85); }
.hero--airy::before {
  content: '';
  position: absolute; inset: 0; z-index: 1;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.18) 0%, transparent 60%);
  pointer-events: none;
}
.hero--attn { filter: saturate(0.55); }
.hero--attn::before {
  content: '';
  position: absolute; inset: 0; z-index: 1;
  background: radial-gradient(110% 90% at 50% 100%, rgba(245, 158, 11, 0.28) 0%, transparent 60%);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .orb-a, .orb-b, .hero-ghost, .sun, .blueprint, .rays, .beam, .pulse path, .spark {
    animation: none;
  }
  .spark { opacity: 0.6; }
}
</style>
