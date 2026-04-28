<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginShader from '@/components/LoginShader.vue'
import { Timer, FileText, GitBranch, CheckCircle2, ArrowRight } from 'lucide-vue-next'

// Internal-team teaser for the Agents section. Same dark glass language
// as the login / forgot pages, but lives inside the app shell so the
// sidebar + header stay reachable. The escape hatch routes admins
// straight into the WIP for builder-led iteration; the router guard
// handles the actual gate.

const router = useRouter()
const auth = useAuthStore()

const PREVIEW_KEY = 'agents.preview'

function previewWip() {
  try { localStorage.setItem(PREVIEW_KEY, '1') } catch { /* ignore */ }
  router.push({ path: '/agents', query: { preview: '1' } })
}

const capabilities = [
  {
    icon: Timer,
    label: 'Stall detection',
    description: 'Flag projects sitting too long at any milestone, with the rule that tripped.',
  },
  {
    icon: FileText,
    label: 'Project narrative',
    description: 'Plain-English summary of where every project is and what’s blocking it.',
  },
  {
    icon: GitBranch,
    label: 'Track A vs Track B',
    description: 'Tells you when a project’s gone off the normal path: redesign, AHJ reject, utility reject, PTO delay.',
  },
  {
    icon: CheckCircle2,
    label: 'Review queue',
    description: 'Every agent suggestion lands in a queue for human approval before it goes live.',
  },
]
</script>

<template>
  <!-- Full-bleed inside the main content area. The shader sits absolute
       to the wrapper (not fixed) so the AppLayout sidebar + header
       above remain visible and interactive. -->
  <div class="ope-stage-wrap -mx-3 -my-4 sm:-mx-6 sm:-my-6">
    <LoginShader class="ope-shader" />

    <main class="ope-stage">
      <section class="ope-card">
        <header class="ope-eyebrow">
          <img src="/img/kin-logo-white.png" alt="" class="ope-logo" />
          <span>Agents · In development</span>
        </header>

        <h1 class="ope-title">Your AI ops team.</h1>
        <p class="ope-subtitle">
          Built to watch every project so you don’t have to. Coming in tranches over the next sprint &mdash; first wave focuses on what’s stalling and why.
        </p>

        <ul class="ope-caps">
          <li v-for="c in capabilities" :key="c.label" class="ope-cap">
            <span class="ope-cap-icon" aria-hidden="true">
              <component :is="c.icon" :size="18" :stroke-width="1.6" />
            </span>
            <div class="ope-cap-body">
              <p class="ope-cap-label">{{ c.label }}</p>
              <p class="ope-cap-desc">{{ c.description }}</p>
            </div>
          </li>
        </ul>

        <p class="ope-footer-note">
          Shipping in tranches. Updates in <span class="ope-mono">#ops-engineering</span>.
        </p>

        <template v-if="auth.isAdmin">
          <hr class="ope-divider" />
          <div class="ope-admin">
            <p class="ope-admin-eyebrow">Admin only</p>
            <button type="button" class="ope-admin-link" @click="previewWip">
              <span>Preview the work-in-progress</span>
              <ArrowRight :size="14" :stroke-width="1.8" />
            </button>
            <p class="ope-admin-note">Internal builders only — work-in-progress, expect rough edges.</p>
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.ope-stage-wrap {
  position: relative;
  min-height: calc(100vh - 56px); /* AppLayout header is 56px (h-14) */
  isolation: isolate;
  overflow: hidden;
  font-family: 'Inter Tight', 'Inter', system-ui, -apple-system, sans-serif;
  color: #f4ede4;
}

.ope-shader {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.ope-stage {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: calc(100vh - 56px);
  padding: 24px;
}

.ope-card {
  width: 560px;
  max-width: 100%;
  min-width: 320px;
  padding: 36px 36px 28px;
  background: rgba(22, 32, 46, 0.72);
  backdrop-filter: blur(22px) saturate(1.1);
  -webkit-backdrop-filter: blur(22px) saturate(1.1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  box-shadow:
    0 30px 80px -30px rgba(0, 0, 0, 0.45),
    0 8px 30px -10px rgba(0, 0, 0, 0.25);
  opacity: 0;
  transform: translateY(8px);
  animation: ope-card-in 600ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}

@keyframes ope-card-in {
  to { opacity: 1; transform: translateY(0); }
}

.ope-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: #f4ede4;
}

.ope-logo {
  display: block;
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.ope-title {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
  line-height: 1.05;
}

.ope-subtitle {
  font-size: 14px;
  color: rgba(244, 237, 228, 0.62);
  margin: 0 0 28px;
  line-height: 1.5;
  max-width: 46ch;
}

.ope-caps {
  list-style: none;
  margin: 0 0 22px;
  padding: 0;
  display: grid;
  gap: 14px;
}

.ope-cap {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.ope-cap:first-child {
  border-top-color: rgba(255, 255, 255, 0.08);
}

.ope-cap-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(244, 237, 228, 0.78);
  flex-shrink: 0;
}

.ope-cap-body {
  min-width: 0;
}

.ope-cap-label {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
  letter-spacing: -0.005em;
  color: #f4ede4;
}

.ope-cap-desc {
  font-size: 13px;
  margin: 0;
  color: rgba(244, 237, 228, 0.58);
  line-height: 1.45;
}

.ope-footer-note {
  font-size: 12px;
  color: rgba(244, 237, 228, 0.5);
  margin: 0;
  text-align: center;
}

.ope-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  color: rgba(244, 237, 228, 0.78);
  font-size: 12px;
}

.ope-divider {
  margin: 22px 0 14px;
  border: 0;
  height: 1px;
  background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.1), transparent);
}

.ope-admin {
  display: grid;
  gap: 6px;
  text-align: center;
}

.ope-admin-eyebrow {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: rgba(244, 237, 228, 0.4);
  margin: 0;
}

.ope-admin-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  border: 0;
  padding: 4px 0;
  color: rgba(244, 237, 228, 0.85);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: color 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ope-admin-link:hover {
  color: #f4ede4;
}

.ope-admin-link:hover span {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.ope-admin-link:focus-visible {
  outline: 2px solid rgba(244, 237, 228, 0.5);
  outline-offset: 4px;
  border-radius: 4px;
}

.ope-admin-note {
  font-size: 11px;
  color: rgba(244, 237, 228, 0.42);
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .ope-card {
    animation: none !important;
    opacity: 1;
    transform: none;
  }
  .ope-admin-link {
    transition: none !important;
  }
}

@media (max-width: 420px) {
  .ope-card {
    width: 100%;
    padding: 28px 22px 22px;
  }
  .ope-stage {
    padding: 16px;
  }
  .ope-title {
    font-size: 26px;
  }
  .ope-subtitle {
    font-size: 13px;
    margin-bottom: 22px;
  }
  .ope-cap-label {
    font-size: 13px;
  }
  .ope-cap-desc {
    font-size: 12px;
  }
}
</style>
