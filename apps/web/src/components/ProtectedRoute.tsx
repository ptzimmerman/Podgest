import { useEffect, useState, useRef } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [initialCheckDone, setInitialCheckDone] = useState(false)
  const location = useLocation()
  const hasEverHadSession = useRef(false)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) {
        hasEverHadSession.current = true
      }
      setLoading(false)
      setInitialCheckDone(true)
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (session) {
        hasEverHadSession.current = true
      }
      // Only redirect to login on explicit sign out, not on tab refocus
      if (event === 'SIGNED_OUT') {
        hasEverHadSession.current = false
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  // Show loading only on initial check, not when refreshing session
  if (loading && !initialCheckDone) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    )
  }

  // Only redirect to login if we've never had a session or explicitly signed out
  // This prevents redirect when session is temporarily null during tab refocus
  if (!session && initialCheckDone && !hasEverHadSession.current) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // If we had a session before but it's null now (and not signed out), 
  // render children anyway - session will refresh
  return <>{children}</>
}
