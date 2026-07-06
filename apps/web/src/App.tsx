import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Login } from './pages/Login'
import { Callback } from './pages/Callback'
import { Settings } from './pages/Settings'
import { Subscriptions } from './pages/Subscriptions'
import { Activity } from './pages/Activity'
import { OnboardingKeys } from './pages/onboarding/Keys'
import { OnboardingPodcasts } from './pages/onboarding/Podcasts'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/callback" element={<Callback />} />

          {/* Onboarding routes (protected but no layout) */}
          <Route
            path="/onboarding/keys"
            element={
              <ProtectedRoute>
                <OnboardingKeys />
              </ProtectedRoute>
            }
          />
          <Route
            path="/onboarding/podcasts"
            element={
              <ProtectedRoute>
                <OnboardingPodcasts />
              </ProtectedRoute>
            }
          />

          {/* Protected routes with layout */}
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/activity" element={<Activity />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
          </Route>

          {/* Redirect root to activity */}
          <Route path="/" element={<Navigate to="/activity" replace />} />

          {/* Catch all - redirect to activity */}
          <Route path="*" element={<Navigate to="/activity" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
