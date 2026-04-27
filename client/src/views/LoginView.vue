<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginShader from '@/components/LoginShader.vue'

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

const LAST_EMAIL_KEY = 'kin.ope.lastEmail'

onMounted(() => {
  try {
    const saved = localStorage.getItem(LAST_EMAIL_KEY)
    if (saved) email.value = saved
  } catch {}
})

async function handleLogin() {
  error.value = ''
  submitting.value = true
  try {
    await auth.login(email.value, password.value)
    try {
      localStorage.setItem(LAST_EMAIL_KEY, email.value)
    } catch {}
    router.push('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Sign-in failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="ope-login">
    <LoginShader class="ope-shader" />

    <main class="ope-stage">
      <section class="ope-card" :class="{ 'is-submitting': submitting }">
        <header class="ope-eyebrow">
          <img src="/img/kin-logo-white.png" alt="" class="ope-logo" />
          <span>Kin Home · Ops GSD</span>
        </header>

        <h1 class="ope-title">Welcome back</h1>
        <p class="ope-subtitle">Sign in to continue your shift.</p>

        <form class="ope-form" @submit.prevent="handleLogin" novalidate>
          <div class="ope-field">
            <label for="ope-email" class="ope-label">Email</label>
            <input
              id="ope-email"
              v-model="email"
              type="email"
              autocomplete="email"
              class="ope-input"
              :class="{ 'has-error': !!error }"
              required
            />
          </div>

          <div class="ope-field">
            <label for="ope-password" class="ope-label">Password</label>
            <input
              id="ope-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="ope-input"
              :class="{ 'has-error': !!error }"
              required
            />
            <p v-if="error" class="ope-error">{{ error }}</p>
          </div>

          <button
            type="submit"
            class="ope-submit"
            :disabled="submitting"
          >
            <span v-if="!submitting">Sign in</span>
            <span v-else class="ope-loader" aria-label="Signing in">
              <span></span><span></span><span></span>
            </span>
          </button>
        </form>

        <p class="ope-footer">
          Need access?
          <RouterLink to="/register" class="ope-link">Request an invite</RouterLink>
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.ope-login {
  position: fixed;
  inset: 0;
  font-family: 'Inter Tight', 'Inter', system-ui, -apple-system, sans-serif;
  color: #f4ede4;
  overflow: hidden;
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
  height: 100%;
  padding: 24px;
}

.ope-card {
  width: 380px;
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
  transition:
    transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1),
    box-shadow 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ope-card.is-submitting {
  transform: translateY(-4px);
  box-shadow:
    0 36px 96px -30px rgba(0, 0, 0, 0.54),
    0 10px 36px -10px rgba(0, 0, 0, 0.3);
}

@keyframes ope-card-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
  line-height: 1.1;
}

.ope-subtitle {
  font-size: 14px;
  color: rgba(244, 237, 228, 0.62);
  margin: 0 0 22px;
}

.ope-form {
  display: grid;
  gap: 14px;
}

.ope-field {
  display: grid;
  gap: 6px;
}

.ope-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
  color: rgba(244, 237, 228, 0.62);
}

.ope-input {
  height: 42px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 0 14px;
  font-size: 14px;
  color: #f4ede4;
  font-family: inherit;
  outline: none;
  transition:
    border-color 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    background 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ope-input::placeholder {
  color: rgba(244, 237, 228, 0.35);
}

.ope-input:hover {
  border-color: rgba(255, 255, 255, 0.16);
}

.ope-input:focus {
  border-color: rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.09);
}

.ope-input.has-error {
  border-color: #f4bd70;
}

.ope-error {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(244, 237, 228, 0.78);
}

.ope-submit {
  margin-top: 8px;
  height: 46px;
  background: #f4ede4;
  color: #16202e;
  border: 0;
  border-radius: 10px;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.02em;
  font-family: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ope-submit:hover:not(:disabled) {
  background: #eae2d6;
}

.ope-submit:disabled {
  cursor: progress;
  background: #e6dccd;
}

.ope-loader {
  display: inline-flex;
  gap: 6px;
}

.ope-loader span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #16202e;
  opacity: 0.35;
  animation: ope-dot 1s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}

.ope-loader span:nth-child(2) {
  animation-delay: 0.15s;
}
.ope-loader span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes ope-dot {
  0%, 100% { opacity: 0.35; transform: translateY(0); }
  50%      { opacity: 1;    transform: translateY(-2px); }
}

.ope-footer {
  margin: 16px 0 0;
  text-align: center;
  font-size: 12px;
  color: rgba(244, 237, 228, 0.62);
}

.ope-link {
  color: #f4ede4;
  text-decoration: none;
  border-bottom: 1px solid #f4ede4;
  padding-bottom: 1px;
  transition: opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ope-link:hover {
  opacity: 0.78;
}

@media (prefers-reduced-motion: reduce) {
  .ope-card,
  .ope-loader span,
  .ope-input,
  .ope-submit,
  .ope-link {
    animation: none !important;
    transition: none !important;
  }
  .ope-card {
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 420px) {
  .ope-card {
    width: 100%;
    padding: 28px 24px 24px;
  }
}
</style>
