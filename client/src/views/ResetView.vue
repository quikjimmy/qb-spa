<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const userName = ref('')
const userEmail = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)
const status = ref<'loading' | 'ready' | 'invalid' | 'expired'>('loading')

onMounted(async () => {
  try {
    const res = await fetch(`/api/auth/reset/${route.params.token}`)
    if (res.status === 410) { status.value = 'expired'; return }
    if (!res.ok) { status.value = 'invalid'; return }
    const data = await res.json()
    userName.value = data.name
    userEmail.value = data.email
    status.value = 'ready'
  } catch {
    status.value = 'invalid'
  }
})

async function handleReset() {
  error.value = ''

  if (password.value.length < 6) {
    error.value = 'Password must be at least 6 characters'
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = 'Passwords do not match'
    return
  }

  loading.value = true
  try {
    const res = await fetch(`/api/auth/reset/${route.params.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    })
    const data = await res.json()
    if (!res.ok) { error.value = data.error || 'Something went wrong'; return }
    auth.setAuth(data.token, data.user)
    router.push('/')
  } catch {
    error.value = 'Something went wrong'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <!-- Loading -->
    <Card v-if="status === 'loading'" class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Checking link…</CardTitle>
      </CardHeader>
    </Card>

    <!-- Invalid -->
    <Card v-else-if="status === 'invalid'" class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Invalid reset link</CardTitle>
        <CardDescription>This link is not valid. Ask your administrator for a new one.</CardDescription>
      </CardHeader>
      <CardContent class="text-center">
        <RouterLink to="/login">
          <Button variant="outline">Go to login</Button>
        </RouterLink>
      </CardContent>
    </Card>

    <!-- Expired -->
    <Card v-else-if="status === 'expired'" class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Link expired</CardTitle>
        <CardDescription>This reset link has expired. Ask your administrator for a new one.</CardDescription>
      </CardHeader>
      <CardContent class="text-center">
        <RouterLink to="/login">
          <Button variant="outline">Go to login</Button>
        </RouterLink>
      </CardContent>
    </Card>

    <!-- Set new password -->
    <Card v-else class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Reset password</CardTitle>
        <CardDescription>
          Pick a new password for <span class="font-medium text-foreground">{{ userEmail }}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form @submit.prevent="handleReset" class="grid gap-4">
          <div class="grid gap-2">
            <Label for="password">New password</Label>
            <Input id="password" v-model="password" type="password" placeholder="At least 6 characters" required minlength="6" />
          </div>
          <div class="grid gap-2">
            <Label for="confirm">Confirm password</Label>
            <Input id="confirm" v-model="confirmPassword" type="password" placeholder="Re-enter your password" required />
          </div>
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
          <Button type="submit" class="w-full" :disabled="loading">
            {{ loading ? 'Saving…' : 'Save & sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
