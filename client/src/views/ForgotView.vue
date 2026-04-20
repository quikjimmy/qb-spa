<script setup lang="ts">
import { ref } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
  <div class="flex min-h-screen items-center justify-center px-4">
    <Card class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Forgot password</CardTitle>
        <CardDescription>
          Enter your email and we'll send you a reset link if there's an account on file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <template v-if="!submitted">
          <form @submit.prevent="handleForgot" class="grid gap-4">
            <div class="grid gap-2">
              <Label for="email">Email</Label>
              <Input id="email" v-model="email" type="email" placeholder="you@example.com" required autofocus />
            </div>
            <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
            <Button type="submit" class="w-full" :disabled="submitting">
              {{ submitting ? 'Sending…' : 'Send reset link' }}
            </Button>
          </form>
          <p class="mt-4 text-center text-sm text-muted-foreground">
            <RouterLink to="/login" class="underline text-primary">Back to sign in</RouterLink>
          </p>
        </template>
        <template v-else>
          <div class="rounded-lg border bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 p-4 text-sm text-emerald-800 dark:text-emerald-300 space-y-2">
            <p class="font-medium">Check your inbox.</p>
            <p>If <span class="font-mono">{{ email }}</span> is registered, a reset link is on its way. It expires in 1 hour.</p>
          </div>
          <p class="mt-4 text-center text-sm text-muted-foreground">
            <RouterLink to="/login" class="underline text-primary">Back to sign in</RouterLink>
          </p>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
