<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const auth = useAuthStore()
const router = useRouter()

const name = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function handleRegister() {
  error.value = ''
  loading.value = true
  try {
    await auth.register(email.value, name.value, password.value)
    router.push('/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Registration failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <Card class="w-full max-w-sm">
      <CardHeader class="text-center">
        <CardTitle class="text-2xl">Create account</CardTitle>
        <CardDescription>Sign up for the Kin Home Portal</CardDescription>
      </CardHeader>
      <CardContent>
        <form @submit.prevent="handleRegister" class="grid gap-4">
          <div class="grid gap-2">
            <Label for="name">Name</Label>
            <Input
              id="name"
              v-model="name"
              type="text"
              placeholder="Your name"
              required
            />
          </div>
          <div class="grid gap-2">
            <Label for="email">Email</Label>
            <Input
              id="email"
              v-model="email"
              type="email"
              placeholder="you@example.com"
              required
            />
          </div>
          <div class="grid gap-2">
            <Label for="password">Password</Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              placeholder="Create a password"
              required
              minlength="6"
            />
          </div>
          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
          <Button type="submit" class="w-full" :disabled="loading">
            {{ loading ? 'Creating account...' : 'Sign up' }}
          </Button>
        </form>
        <p class="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?
          <RouterLink to="/login" class="underline text-primary">Sign in</RouterLink>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
