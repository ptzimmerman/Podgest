import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.podgest.app'

export function OnboardingKeys() {
  const navigate = useNavigate()
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openaiSaved, setOpenaiSaved] = useState(false)
  const [anthropicSaved, setAnthropicSaved] = useState(false)

  useEffect(() => {
    // Check if user already has keys configured
    checkExistingKeys()
  }, [])

  const checkExistingKeys = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      navigate('/login')
      return
    }

    const { data } = await supabase
      .from('user_api_keys')
      .select('openai_key_encrypted, anthropic_key_encrypted')
      .eq('user_id', session.user.id)
      .single()

    if (data?.openai_key_encrypted) setOpenaiSaved(true)
    if (data?.anthropic_key_encrypted) setAnthropicSaved(true)
  }

  const validateAndSaveKey = async (keyType: string, key: string) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Not authenticated')

    // Validate
    const validateRes = await fetch(`${API_URL}/api/validate-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ key_type: keyType, key }),
    })

    if (!validateRes.ok) {
      const error = await validateRes.json()
      throw new Error(error.error || 'Validation failed')
    }

    const { valid } = await validateRes.json()
    if (!valid) {
      throw new Error(`Invalid ${keyType} API key`)
    }

    // Save
    const saveRes = await fetch(`${API_URL}/api/user-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ key_type: keyType, key }),
    })

    if (!saveRes.ok) {
      const error = await saveRes.json()
      throw new Error(error.error || 'Failed to save')
    }
  }

  const handleSaveOpenAI = async () => {
    if (!openaiKey) return
    setSaving(true)
    setError(null)
    try {
      await validateAndSaveKey('openai', openaiKey)
      setOpenaiSaved(true)
      setOpenaiKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save OpenAI key')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAnthropic = async () => {
    if (!anthropicKey) return
    setSaving(true)
    setError(null)
    try {
      await validateAndSaveKey('anthropic', anthropicKey)
      setAnthropicSaved(true)
      setAnthropicKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Anthropic key')
    } finally {
      setSaving(false)
    }
  }

  const canContinue = openaiSaved && anthropicSaved

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-white font-medium">1</div>
              <span className="ml-2 text-sm font-medium text-indigo-600">API Keys</span>
            </div>
            <div className="w-12 h-0.5 bg-gray-300"></div>
            <div className="flex items-center">
              <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center text-gray-600 font-medium">2</div>
              <span className="ml-2 text-sm text-gray-500">Podcasts</span>
            </div>
          </div>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Connect Your AI Services</h1>
          <p className="mt-3 text-lg text-gray-600">
            Podgest uses AI to transcribe, summarize, and generate your personalized podcast digests.
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {/* OpenAI Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center">
                  <h2 className="text-lg font-semibold text-gray-900">OpenAI</h2>
                  {openaiSaved && (
                    <span className="ml-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      ✓ Connected
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm text-gray-600">
                  Powers <strong>semantic search</strong> across your podcast transcripts. Ask questions like "What did they say about AI regulation?" and find relevant moments instantly.
                </p>
              </div>
            </div>

            {!openaiSaved && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">API Key</label>
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center"
                  >
                    Get your key
                    <svg className="ml-1 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <div className="flex gap-3">
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    placeholder="sk-proj-..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                  />
                  <button
                    onClick={handleSaveOpenAI}
                    disabled={!openaiKey || saving}
                    className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Anthropic Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center">
                  <h2 className="text-lg font-semibold text-gray-900">Anthropic (Claude)</h2>
                  {anthropicSaved && (
                    <span className="ml-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      ✓ Connected
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm text-gray-600">
                  Powers your <strong>daily digest generation</strong>. Claude reads through all your podcast transcripts and crafts a personalized summary highlighting the most interesting insights and stories.
                </p>
              </div>
            </div>

            {!anthropicSaved && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">API Key</label>
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center"
                  >
                    Get your key
                    <svg className="ml-1 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <div className="flex gap-3">
                  <input
                    type="password"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                  />
                  <button
                    onClick={handleSaveAnthropic}
                    disabled={!anthropicKey || saving}
                    className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Info box */}
          <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
            <div className="flex">
              <svg className="h-5 w-5 text-blue-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-blue-800">Your keys are secure</h3>
                <p className="mt-1 text-sm text-blue-700">
                  API keys are encrypted with AES-256 before storage. We never see or store your keys in plain text.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Continue button */}
        <div className="mt-8 flex justify-end">
          <button
            onClick={() => navigate('/onboarding/podcasts')}
            disabled={!canContinue}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              canContinue
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-200 text-gray-500 cursor-not-allowed'
            }`}
          >
            Continue to Podcasts →
          </button>
        </div>

        {!canContinue && (
          <p className="mt-4 text-center text-sm text-gray-500">
            Add both API keys to continue
          </p>
        )}
      </div>
    </div>
  )
}
