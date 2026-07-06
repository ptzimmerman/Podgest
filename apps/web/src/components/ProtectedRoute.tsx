import { useRef } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { authClient } from '../lib/auth'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { data: session, isPending } = authClient.useSession()
  const location = useLocation()
  const hasEverHadSession = useRef(false)

  if (session) {
    hasEverHadSession.current = true
  }

  // Show loading only on the initial session check
  if (isPending && !hasEverHadSession.current) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    )
  }

  // Only redirect to login if we've definitely never had a session.
  // This prevents redirect when the session is temporarily null during refetch.
  if (!session && !isPending && !hasEverHadSession.current) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // If we had a session before but it's null now (mid-refresh), render children anyway
  return <>{children}</>
}
