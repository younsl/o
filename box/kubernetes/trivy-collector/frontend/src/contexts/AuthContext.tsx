import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthStatus, AuthUser } from '../types'
import { getAuthStatus, redirectToLogin } from '../auth'

interface AuthContextValue {
  authMode: string
  authenticated: boolean
  user: AuthUser | null
  loading: boolean
  loginAt: string | null
}

const AuthContext = createContext<AuthContextValue>({
  authMode: 'none',
  authenticated: false,
  user: null,
  loading: true,
  loginAt: null,
})

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loginAt, setLoginAt] = useState<string | null>(null)

  useEffect(() => {
    getAuthStatus()
      .then((s) => {
        setStatus(s)
        if (s.authenticated) {
          setLoginAt(new Date().toISOString())
        }
        setLoading(false)
      })
      .catch(() => {
        setStatus({ authenticated: false, auth_mode: 'none' })
        setLoading(false)
      })
  }, [])

  const value: AuthContextValue = {
    authMode: status?.auth_mode ?? 'none',
    authenticated: status?.authenticated ?? false,
    user: status?.user ?? null,
    loading,
    loginAt,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

interface AuthGateProps {
  children: ReactNode
}

export function AuthGate({ children }: AuthGateProps) {
  const { authMode, authenticated, loading } = useAuth()

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        color: 'var(--text-muted)',
      }}>
        Checking authentication...
      </div>
    )
  }

  if (authMode === 'keycloak' && !authenticated) {
    redirectToLogin(window.location.pathname)
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        color: 'var(--text-muted)',
      }}>
        Redirecting to login...
      </div>
    )
  }

  return <>{children}</>
}
