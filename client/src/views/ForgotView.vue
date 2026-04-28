<script setup lang="ts">
import { ref } from 'vue'
import LoginShader from '@/components/LoginShader.vue'

const email = ref('')
const submitting = ref(false)
const submitted = ref(false)
const error = ref('')

async function handleForgot() {
  error.value = ''
  if (!email.value.trim() || !email.value.includes('@')) {
    error.value = 'Enter a valid email address'
    return
  }
  submitting.value = true
  try {
    const res = await fetch('/api/auth/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      error.value = data.error || 'Something went wrong'
      return
    }
    submitted.value = true
  } catch {
    error.value = 'Something went wrong'
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

        <template v-if="!submitted">
          <h1 class="ope-title">Forgot password</h1>
          <p class="ope-subtitle">Enter your email and we'll send you a reset link.</p>

          <form class="ope-form" @submit.prevent="handleForgot" novalidate>
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
                autofocus
              />
              <p v-if="error" class="ope-error">{{ error }}</p>
            </div>

            <button type="submit" class="ope-submit" :disabled="submitting">
              <span v-if="!submitting">Send reset link</span>
              <span v-else class="ope-loader" aria-label="Sending">
                <span></span><span></span><span></span>
              </span>
            </button>
          </form>

          <p class="ope-footer">
            Remembered it?
            <RouterLink to="/login" class="ope-link">Back to sign in</RouterLink>
          </p>
        </template>

        <template v-else>
          <h1 class="ope-title">Check your inbox</h1>
          <p class="ope-subtitle">
            If <span class="ope-mono">{{ email }}</span> is registered, a reset link is on its way. It expires in 1 hour.
          </p>

          <div class="ope-form">
            <RouterLink to="/login" class="ope-submit ope-submit--linklike">Back to sign in</RouterLink>
          </div>
        </template>
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
  line-height: 1.45;
}

.ope-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  color: rgba(244, 237, 228, 0.85);
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
  text-decoration: none;
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

.ope-submit--linklike {
  /* Same primary visual weight as the form CTA, used as the
     post-submit "Back to sign in" action so the success state
     still has a clear next step. */
  margin-top: 0;
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
