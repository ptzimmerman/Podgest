import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export function Callback() {
  const navigate = useNavigate()

  useEffect(() => {
    const checkOnboardingStatus = async (userId: string) => {
      // Check if user has API keys configured
      const { data: keysData } = await supabase
        .from('user_api_keys')
        .select('openai_key_encrypted, anthropic_key_encrypted')
        .eq('user_id', userId)
        .single()

      const hasKeys = keysData?.openai_key_encrypted && keysData?.anthropic_key_encrypted

      if (!hasKeys) {
        // Needs to add API keys
        navigate('/onboarding/keys')
        return
      }

      // Check if user has any subscriptions
      const { data: subsData } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('user_id', userId)
        .limit(1)

      const hasSubscriptions = subsData && subsData.length > 0

      if (!hasSubscriptions) {
        // Has keys but no subscriptions
        navigate('/onboarding/podcasts')
        return
      }

      // Fully onboarded - go to settings/dashboard
      navigate('/settings')
    }

    // Handle the OAuth callback
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        checkOnboardingStatus(session.user.id)
      } else if (event === 'SIGNED_OUT') {
        navigate('/login')
      }
    })
  }, [navigate])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
        <p className="mt-4 text-sm text-gray-600">Setting up your account...</p>
      </div>
    </div>
  )
}
