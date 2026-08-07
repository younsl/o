import type { AuthStatus } from './types'

export async function getAuthStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/v1/auth/me')
  return response.json() as Promise<AuthStatus>
}

export function redirectToLogin(returnTo?: string): void {
  const params = new URLSearchParams()
  if (returnTo) params.append('return_to', returnTo)
  window.location.href = `/auth/login?${params}`
}

export function logout(): void {
  window.location.href = '/auth/logout'
}
