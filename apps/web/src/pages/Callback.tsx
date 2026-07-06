import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authClient } from '../lib/auth'

const API_URL = 'https://api.podgest.app'

export function Callback() {
  const navigate = useNavigate()

  useEffect(() => {
    const checkOnboardingStatus = async () => {
      // Check if user has API keys configured
      try {
        const keysRes = await fetch(`${API_URL}/api/user-keys/status`, {
          credentials: 'include',
        })
        const keysData = keysRes.ok
          ? await keysRes.json() as { openai: { configured: boolean }; anthropic: { configured: boolean } }
          : null

        const hasKeys = keysData?.openai.configured && keysData?.anthropic.configured

        if (!hasKeys) {
          // Needs to add API keys
          navigate('/onboarding/keys')
          return
        }

        // Check if user has any subscriptions
        const subsRes = await fetch(`${API_URL}/api/subscriptions`, {
          credentials: 'include',
        })
        const subsData = subsRes.ok
          ? await subsRes.json() as { subscriptions: { id: string }[] }
          : null

        const hasSubscriptions = subsData && subsData.subscriptions.length > 0

        if (!hasSubscriptions) {
          // Has keys but no subscriptions
          navigate('/onboarding/podcasts')
          return
        }

        // Fully onboarded - go to settings/dashboard
        navigate('/settings')
      } catch {
        // If the checks fail, fall back to settings rather than trapping the user here
        navigate('/settings')
      }
    }

    // After the Better Auth redirect, the session cookie is already set —
    // just verify it and route based on onboarding state.
    authClient.getSession().then(({ data }) => {
      if (data?.session) {
        checkOnboardingStatus()
      } else {
        navigate('/login')
      }
    })
  }, [navigate])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
        <p className="mt-4 text-sm text-gray-600">Loading...</p>
      </div>
    </div>
  )
}
