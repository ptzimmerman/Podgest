import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authClient } from '../lib/auth'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.podgest.app'

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Mexico_City', label: 'Mexico City (CST)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'UTC', label: 'UTC' },
]

/** Include stored IANA zones missing from TIMEZONES so the select reflects the backend. */
function timezoneOptions(stored?: string | null) {
  if (!stored || TIMEZONES.some((tz) => tz.value === stored)) {
    return TIMEZONES
  }
  const label = stored.replace(/_/g, ' ').replace(/\//g, ' — ')
  return [...TIMEZONES, { value: stored, label: `${label} (saved)` }]
}

// Generate 30-minute increments from 00:00 to 23:30
const DIGEST_TIMES = Array.from({ length: 48 }, (_, i) => {
  const hours = Math.floor(i / 2)
  const minutes = (i % 2) * 30
  const value = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours
  const ampm = hours < 12 ? 'AM' : 'PM'
  const label = `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`
  return { value, label }
})

type KeyStatus = {
  openai: { configured: boolean; valid: boolean | null }
  anthropic: { configured: boolean; valid: boolean | null }
}

export function Settings() {
  const { data: session } = authClient.useSession()
  const userId = session?.user.id ?? null
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [copiedFeed, setCopiedFeed] = useState(false)
  const [copiedMcp, setCopiedMcp] = useState(false)
  const [digestLength, setDigestLength] = useState(5)
  const [digestTime, setDigestTime] = useState('06:00')
  const [timezone, setTimezone] = useState('America/Chicago')
  const [savingDigestPrefs, setSavingDigestPrefs] = useState(false)
  const [validating, setValidating] = useState<{ openai: boolean; anthropic: boolean }>({
    openai: false, anthropic: false
  })
  const [validationResult, setValidationResult] = useState<{ 
    openai?: { valid: boolean; error?: string };
    anthropic?: { valid: boolean; error?: string };
  }>({})
  const [generatingDigest, setGeneratingDigest] = useState(false)
  const [currentDigestId, setCurrentDigestId] = useState<string | null>(null)
  const [digestStatus, setDigestStatus] = useState<string | null>(null)
  const [lastDigestError, setLastDigestError] = useState<string | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  
  // Show toast with auto-dismiss
  const showToast = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setToastVisible(true)
    setTimeout(() => {
      setToastVisible(false)
      setTimeout(() => setMessage(null), 300) // Wait for slide-out animation
    }, 3000)
  }

  useEffect(() => {
    fetchKeyStatus()
    fetchDigestPreferences()
    checkInProgressDigest()
  }, [])
  
  // Poll for digest status while generating
  useEffect(() => {
    if (!currentDigestId || !generatingDigest) return
    
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/digests/${currentDigestId}`, {
          credentials: 'include',
        })
        if (!res.ok) {
          console.error('Error polling digest status:', res.status)
          return
        }
        const { digest } = await res.json() as { digest: { status: string; error_message: string | null } }

        setDigestStatus(digest.status)

        if (digest.status === 'completed') {
          setGeneratingDigest(false)
          showToast('success', 'Digest generated successfully!')
          clearInterval(pollInterval)
        } else if (digest.status === 'failed') {
          setGeneratingDigest(false)
          setLastDigestError(digest.error_message || 'Generation failed')
          showToast('error', digest.error_message || 'Digest generation failed')
          clearInterval(pollInterval)
        }
      } catch (err) {
        console.error('Error polling digest status:', err)
      }
    }, 3000) // Poll every 3 seconds
    
    return () => clearInterval(pollInterval)
  }, [currentDigestId, generatingDigest])
  
  const checkInProgressDigest = async () => {
    try {
      // Check for any pending or processing digests for this user
      const res = await fetch(`${API_URL}/api/digests/in-progress`, {
        credentials: 'include',
      })
      if (!res.ok) return

      const { digest } = await res.json() as { digest: { id: string; status: string; error_message: string | null } | null }

      if (digest) {
        setCurrentDigestId(digest.id)
        setDigestStatus(digest.status)
        setGeneratingDigest(true)
      }
    } catch (err) {
      console.error('Error checking in-progress digest:', err)
    }
  }
  
  const handleGenerateDigest = async () => {
    if (generatingDigest) return
    
    setGeneratingDigest(true)
    setLastDigestError(null)
    setMessage(null)
    
    try {
      const { data: sessionData } = await authClient.getSession()
      if (!sessionData?.session) throw new Error('Not authenticated')
      
      const res = await fetch(`${API_URL}/api/generate-digest`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          user_id: sessionData.user.id,
          hours_back: 48, // Look back 48 hours for content
          force: true // Generate even if recent digest exists
        }),
      })
      
      const data = await res.json() as { digest_id?: string; error?: string }
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start digest generation')
      }
      
      if (data.digest_id) {
        setCurrentDigestId(data.digest_id)
        setDigestStatus('pending')
        showToast('success', 'Digest generation started...')
      }
    } catch (err) {
      setGeneratingDigest(false)
      showToast('error', err instanceof Error ? err.message : 'Failed to generate digest')
    }
  }

  const fetchKeyStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/user-keys/status`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to fetch key status')

      const status = await res.json() as KeyStatus
      setKeyStatus(status)
    } catch (err) {
      console.error('Error fetching key status:', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchDigestPreferences = async () => {
    try {
      const res = await fetch(`${API_URL}/api/profile`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to fetch profile')

      const { profile } = await res.json() as {
        profile: { digest_length_minutes: number | null; timezone: string | null; digest_time: string | null }
      }
      if (profile?.digest_length_minutes) {
        setDigestLength(profile.digest_length_minutes)
      }
      if (profile?.timezone) {
        setTimezone(profile.timezone)
      }
      if (profile?.digest_time) {
        // digest_time is stored as HH:MM:SS, convert to HH:MM
        setDigestTime(profile.digest_time.substring(0, 5))
      }
    } catch (err) {
      console.error('Error fetching digest preferences:', err)
    }
  }

  const saveDigestPreferences = async (updates: { 
    digest_length_minutes?: number; 
    timezone?: string; 
    digest_time?: string;
  }) => {
    setSavingDigestPrefs(true)
    try {
      const res = await fetch(`${API_URL}/api/profile`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })

      if (!res.ok) throw new Error('Failed to save preferences')
      showToast('success', 'Preferences saved')
    } catch (err) {
      console.error('Error saving preferences:', err)
      showToast('error', 'Failed to save preferences')
    } finally {
      setSavingDigestPrefs(false)
    }
  }

  const handleDigestLengthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value)
    setDigestLength(value)
  }

  const handleDigestLengthCommit = (e: React.SyntheticEvent<HTMLInputElement>) => {
    const value = parseInt(e.currentTarget.value, 10)
    setDigestLength(value)
    saveDigestPreferences({ digest_length_minutes: value })
  }
  
  const handleTimezoneChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    setTimezone(value)
    saveDigestPreferences({ timezone: value })
  }
  
  const handleDigestTimeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    setDigestTime(value)
    saveDigestPreferences({ digest_time: value })
  }

  const validateKey = async (keyType: 'openai' | 'anthropic', key: string) => {
    if (!key) {
      setValidationResult(prev => ({ ...prev, [keyType]: { valid: false, error: 'Please enter a key first' } }))
      return
    }

    setValidating(prev => ({ ...prev, [keyType]: true }))
    setValidationResult(prev => ({ ...prev, [keyType]: undefined }))

    try {
      const res = await fetch(`${API_URL}/api/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_type: keyType, key }),
      })

      const result = await res.json() as { valid: boolean; error?: string; errorCode?: string }
      setValidationResult(prev => ({ ...prev, [keyType]: result }))
    } catch (err) {
      setValidationResult(prev => ({ 
        ...prev, 
        [keyType]: { valid: false, error: 'Failed to validate key' } 
      }))
    } finally {
      setValidating(prev => ({ ...prev, [keyType]: false }))
    }
  }

  const validateAndSaveKey = async (keyType: string, key: string) => {
    // Validate key first
    const validateRes = await fetch(`${API_URL}/api/validate-key`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
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

    // Save key
    const saveRes = await fetch(`${API_URL}/api/user-keys`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key_type: keyType, key }),
    })

    if (!saveRes.ok) {
      const error = await saveRes.json()
      throw new Error(error.error || 'Failed to save key')
    }

    return true
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    const results: string[] = []
    const errors: string[] = []

    try {
      if (openaiKey) {
        try {
          await validateAndSaveKey('openai', openaiKey)
          results.push('OpenAI')
          setOpenaiKey('')
        } catch (err) {
          errors.push(`OpenAI: ${err instanceof Error ? err.message : 'Failed'}`)
        }
      }

      if (anthropicKey) {
        try {
          await validateAndSaveKey('anthropic', anthropicKey)
          results.push('Anthropic')
          setAnthropicKey('')
        } catch (err) {
          errors.push(`Anthropic: ${err instanceof Error ? err.message : 'Failed'}`)
        }
      }

      if (errors.length > 0) {
        showToast('error', errors.join('; '))
      } else if (results.length > 0) {
        showToast('success', `Saved: ${results.join(', ')}`)
      }

      // Refresh status
      await fetchKeyStatus()
    } finally {
      setSaving(false)
    }
  }

  const copyToClipboard = async (text: string, type: 'feed' | 'mcp') => {
    await navigator.clipboard.writeText(text)
    if (type === 'feed') {
      setCopiedFeed(true)
      setTimeout(() => setCopiedFeed(false), 2000)
    } else {
      setCopiedMcp(true)
      setTimeout(() => setCopiedMcp(false), 2000)
    }
  }

  const handleDeleteAccount = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`${API_URL}/api/delete-account`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to delete account')
      }

      // Sign out and redirect to login
      await authClient.signOut()
      navigate('/login')
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete account')
      setDeleting(false)
      setShowDeleteModal(false)
      setDeleteConfirmation('')
    }
  }

  const StatusBadge = ({ status }: { status: { configured: boolean; valid: boolean | null } }) => {
    if (!status.configured) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
          Not configured
        </span>
      )
    }
    if (status.valid === true) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
          Configured
        </span>
      )
    }
    if (status.valid === false) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
          Invalid
        </span>
      )
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
        Configured (unverified)
      </span>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    )
  }

  const allKeysConfigured = keyStatus?.openai.configured && keyStatus?.anthropic.configured
  const rssFeedUrl = userId ? `${API_URL}/feed/${userId}.xml` : ''
  const mcpServerUrl = 'https://mcp.podgest.app'

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Manage your Podgest configuration and integrations.
        </p>
      </div>

      {/* Toast notification */}
      {message && (
        <div 
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-lg shadow-lg transition-all duration-300 ease-out ${
            toastVisible ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'
          } ${
            message.type === 'success' 
              ? 'bg-green-600 text-white' 
              : 'bg-red-600 text-white'
          }`}
        >
          <div className="flex items-center gap-2">
            {message.type === 'success' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {message.text}
          </div>
        </div>
      )}

      {!allKeysConfigured && (
        <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <strong>Action Required:</strong> You must configure your OpenAI and Anthropic API keys to generate digests.
        </div>
      )}

      {/* RSS Feed Section */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 bg-orange-100 dark:bg-orange-900/50 rounded-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 5c7.18 0 13 5.82 13 13M6 11a7 7 0 017 7m-6 0a1 1 0 11-2 0 1 1 0 012 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Your Podcast Feed</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Subscribe to your personalized Podgest digest in any podcast app (Apple Podcasts, Spotify, Overcast, etc.)
            </p>
            
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">RSS Feed URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={rssFeedUrl}
                  className="flex-1 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-300 font-mono"
                />
                <button
                  onClick={() => copyToClipboard(rssFeedUrl, 'feed')}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-2"
                >
                  {copiedFeed ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Paste this URL into your podcast app's "Add by URL" or "Add RSS Feed" option.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Digest Preferences Section */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Digest Preferences</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Customize your daily podcast digest
            </p>
            
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Digest Length
                </label>
                <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                  {digestLength} min
                </span>
              </div>
              
              <input
                type="range"
                min="5"
                max="20"
                step="1"
                value={digestLength}
                onChange={handleDigestLengthChange}
                onMouseUp={handleDigestLengthCommit}
                onTouchEnd={handleDigestLengthCommit}
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span>5 min</span>
                <span>10 min</span>
                <span>15 min</span>
                <span>20 min</span>
              </div>
              
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Longer digests include more content and use more API tokens.
              </p>
            </div>
            
            {/* Schedule Settings */}
            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">Daily Schedule</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Time
                  </label>
                  <select
                    value={digestTime}
                    onChange={handleDigestTimeChange}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
                  >
                    {DIGEST_TIMES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Timezone
                  </label>
                  <select
                    value={timezone}
                    onChange={handleTimezoneChange}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
                  >
                    {timezoneOptions(timezone).map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {savingDigestPrefs && (
                <p className="mt-2 text-xs text-indigo-600 dark:text-indigo-400">Saving...</p>
              )}
            </div>
            
            {/* Generate Now Button */}
            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Generate Now</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Manually create a {digestLength}-minute digest from recent episodes
                  </p>
                </div>
                <button
                  onClick={handleGenerateDigest}
                  disabled={generatingDigest || !allKeysConfigured}
                  className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {generatingDigest ? (
                    <>
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {digestStatus === 'pending' ? 'Starting...' : 
                       digestStatus === 'processing' ? 'Processing...' :
                       digestStatus === 'transcribing' ? 'Transcribing...' :
                       digestStatus === 'generating_script' ? 'Writing script...' :
                       digestStatus === 'generating_audio' ? 'Generating audio...' :
                       'Generating...'}
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Generate
                    </>
                  )}
                </button>
              </div>
              {!allKeysConfigured && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Configure your API keys below to enable digest generation.
                </p>
              )}
              {lastDigestError && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                  Last error: {lastDigestError}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* MCP Server Section */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 bg-purple-100 dark:bg-purple-900/50 rounded-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Assistant Integration (MCP)</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Connect Podgest to Claude, ChatGPT, or Cursor to search and analyze your podcast library with AI.
            </p>

            <div className="mt-4 bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What you can do:</h3>
              <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                <li className="flex items-start gap-2">
                  <span className="text-purple-600 dark:text-purple-400 mt-0.5">•</span>
                  <span><strong>Search across all podcasts</strong> — "What have people said about AI regulation?"</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-600 dark:text-purple-400 mt-0.5">•</span>
                  <span><strong>Compare perspectives</strong> — "How do different hosts view the future of remote work?"</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-600 dark:text-purple-400 mt-0.5">•</span>
                  <span><strong>Get episode details</strong> — Find transcripts and listen links for any episode</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-600 dark:text-purple-400 mt-0.5">•</span>
                  <span><strong>Discover connections</strong> — Find themes across different shows you follow</span>
                </li>
              </ul>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">MCP Server URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={mcpServerUrl}
                  className="flex-1 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-300 font-mono"
                />
                <button
                  onClick={() => copyToClipboard(mcpServerUrl, 'mcp')}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-2"
                >
                  {copiedMcp ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Setup Instructions:</h3>
              
              <details className="group">
                <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
                  <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Claude Desktop (macOS/Windows)
                </summary>
                <div className="mt-2 ml-6 text-sm text-gray-600 dark:text-gray-400 space-y-2">
                  <p>1. Open Claude Desktop settings → Developer → Edit Config</p>
                  <p>2. Add to your <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">claude_desktop_config.json</code>:</p>
                  <pre className="bg-gray-800 text-gray-100 p-3 rounded-lg text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "podgest": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${mcpServerUrl}/sse"]
    }
  }
}`}
                  </pre>
                  <p>3. Restart Claude Desktop and sign in when prompted</p>
                </div>
              </details>

              <details className="group">
                <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
                  <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Claude Mobile (iOS/Android)
                </summary>
                <div className="mt-2 ml-6 text-sm text-gray-600 dark:text-gray-400 space-y-2">
                  <p>1. Go to <a href="https://claude.ai/settings/mcp" target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 underline">claude.ai/settings/mcp</a></p>
                  <p>2. Click "Add Server" and paste the MCP Server URL</p>
                  <p>3. Sign in with Google when prompted</p>
                </div>
              </details>

              <details className="group">
                <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
                  <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  ChatGPT Desktop
                </summary>
                <div className="mt-2 ml-6 text-sm text-gray-600 dark:text-gray-400 space-y-2">
                  <p>1. Open ChatGPT Desktop → Settings → Developer Mode</p>
                  <p>2. Click "Add MCP Connector"</p>
                  <p>3. Paste the MCP Server URL and connect</p>
                </div>
              </details>

              <details className="group">
                <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
                  <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Cursor IDE
                </summary>
                <div className="mt-2 ml-6 text-sm text-gray-600 dark:text-gray-400 space-y-2">
                  <p>1. Create <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">.cursor/mcp.json</code> in your project:</p>
                  <pre className="bg-gray-800 text-gray-100 p-3 rounded-lg text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "podgest": {
      "url": "${mcpServerUrl}/sse"
    }
  }
}`}
                  </pre>
                  <p>2. Restart Cursor and sign in when prompted</p>
                </div>
              </details>
            </div>
          </div>
        </div>
      </section>

      {/* API Keys Section */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">API Keys</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Your API keys are encrypted and stored securely. They are required to generate your podcast digests.
          </p>
        </div>

        <div className="space-y-6">
          {/* OpenAI Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="openai-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                OpenAI API Key <span className="text-red-500">*</span>
              </label>
              {keyStatus && <StatusBadge status={keyStatus.openai} />}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Required for embeddings (semantic search)
            </p>
            <div className="mt-2 flex gap-2">
              <input
                type="password"
                id="openai-key"
                value={openaiKey}
                onChange={(e) => { setOpenaiKey(e.target.value); setValidationResult(prev => ({ ...prev, openai: undefined })) }}
                placeholder={keyStatus?.openai.configured ? 'Enter new key to replace' : 'sk-...'}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => validateKey('openai', openaiKey)}
                disabled={!openaiKey || validating.openai}
                className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {validating.openai ? 'Testing...' : 'Test'}
              </button>
            </div>
            {validationResult.openai && (
              <p className={`mt-2 text-sm ${validationResult.openai.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {validationResult.openai.valid ? '✓ Key is valid' : `✗ ${validationResult.openai.error || 'Invalid key'}`}
              </p>
            )}
          </div>

          {/* Anthropic Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="anthropic-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Anthropic API Key <span className="text-red-500">*</span>
              </label>
              {keyStatus && <StatusBadge status={keyStatus.anthropic} />}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Required for summarization and script generation
            </p>
            <div className="mt-2 flex gap-2">
              <input
                type="password"
                id="anthropic-key"
                value={anthropicKey}
                onChange={(e) => { setAnthropicKey(e.target.value); setValidationResult(prev => ({ ...prev, anthropic: undefined })) }}
                placeholder={keyStatus?.anthropic.configured ? 'Enter new key to replace' : 'sk-ant-...'}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => validateKey('anthropic', anthropicKey)}
                disabled={!anthropicKey || validating.anthropic}
                className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {validating.anthropic ? 'Testing...' : 'Test'}
              </button>
            </div>
            {validationResult.anthropic && (
              <p className={`mt-2 text-sm ${validationResult.anthropic.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {validationResult.anthropic.valid ? '✓ Key is valid' : `✗ ${validationResult.anthropic.error || 'Invalid key'}`}
              </p>
            )}
          </div>

        </div>

        <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleSave}
            disabled={saving || (!openaiKey && !anthropicKey)}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save API Keys'}
          </button>
        </div>
      </section>

      {/* Info Section */}
      <section className="bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">Where to get API keys</h3>
        <ul className="mt-2 text-sm text-blue-700 dark:text-blue-400 space-y-1">
          <li>• <strong>OpenAI</strong>: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">platform.openai.com/api-keys</a></li>
          <li>• <strong>Anthropic</strong>: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline">console.anthropic.com/settings/keys</a></li>
        </ul>
      </section>

      {/* Danger Zone */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border-2 border-red-300 dark:border-red-700 p-6">
        <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">Danger Zone</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        <button
          onClick={() => setShowDeleteModal(true)}
          className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
        >
          Delete Account
        </button>
      </section>

      {/* Delete Account Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => { setShowDeleteModal(false); setDeleteConfirmation('') }} />
          <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Delete your account?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              This is <strong>permanent</strong> and cannot be undone. All of your data will be deleted, including:
            </p>
            <ul className="text-sm text-gray-600 dark:text-gray-400 mb-4 space-y-1 ml-4 list-disc">
              <li>Your profile and settings</li>
              <li>All podcast subscriptions</li>
              <li>All generated digests and audio</li>
              <li>Your API keys</li>
            </ul>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
              Type <strong className="font-mono text-red-600 dark:text-red-400">delete</strong> to confirm:
            </p>
            <input
              type="text"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              placeholder="delete"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 text-sm bg-white dark:bg-gray-900 dark:text-white mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteModal(false); setDeleteConfirmation('') }}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmation !== 'delete' || deleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting...' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
