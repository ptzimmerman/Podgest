import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const API_URL = import.meta.env.VITE_API_URL || 'https://podgest-api.petehodgson.workers.dev'

type KeyStatus = {
  openai: { configured: boolean; valid: boolean | null; masked?: string }
  anthropic: { configured: boolean; valid: boolean | null; masked?: string }
  elevenlabs: { configured: boolean; valid: boolean | null; masked?: string }
}

export function Settings() {
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [elevenLabsKey, setElevenLabsKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    fetchKeyStatus()
  }, [])

  const fetchKeyStatus = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const { data, error } = await supabase
        .from('user_api_keys')
        .select('key_type, openai_valid, anthropic_valid, elevenlabs_valid')
        .eq('user_id', session.user.id)

      if (error) throw error

      const status: KeyStatus = {
        openai: { configured: false, valid: null },
        anthropic: { configured: false, valid: null },
        elevenlabs: { configured: false, valid: null },
      }

      data?.forEach((row: { key_type: string; openai_valid: boolean | null; anthropic_valid: boolean | null; elevenlabs_valid: boolean | null }) => {
        if (row.key_type === 'openai') {
          status.openai = { configured: true, valid: row.openai_valid, masked: 'sk-...configured' }
        } else if (row.key_type === 'anthropic') {
          status.anthropic = { configured: true, valid: row.anthropic_valid, masked: 'sk-ant-...configured' }
        } else if (row.key_type === 'elevenlabs') {
          status.elevenlabs = { configured: true, valid: row.elevenlabs_valid, masked: 'xi-...configured' }
        }
      })

      setKeyStatus(status)
    } catch (err) {
      console.error('Error fetching key status:', err)
    } finally {
      setLoading(false)
    }
  }

  const validateAndSaveKey = async (keyType: string, key: string) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Not authenticated')

    // Validate key first
    const validateRes = await fetch(`${API_URL}/api/validate-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ keyType, key }),
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ keyType, key }),
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

      if (elevenLabsKey) {
        try {
          await validateAndSaveKey('elevenlabs', elevenLabsKey)
          results.push('ElevenLabs')
          setElevenLabsKey('')
        } catch (err) {
          errors.push(`ElevenLabs: ${err instanceof Error ? err.message : 'Failed'}`)
        }
      }

      if (results.length > 0) {
        setMessage({ type: 'success', text: `Saved: ${results.join(', ')}` })
      }
      if (errors.length > 0) {
        setMessage({ type: 'error', text: errors.join('; ') })
      }

      // Refresh status
      await fetchKeyStatus()
    } finally {
      setSaving(false)
    }
  }

  const StatusBadge = ({ status }: { status: { configured: boolean; valid: boolean | null } }) => {
    if (!status.configured) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
          Using shared key
        </span>
      )
    }
    if (status.valid === true) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
          ✓ Configured
        </span>
      )
    }
    if (status.valid === false) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
          ✗ Invalid
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your API keys and preferences.
        </p>
      </div>

      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {message.text}
        </div>
      )}

      {/* API Keys Section */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">API Keys</h2>
          <p className="mt-1 text-sm text-gray-500">
            Your API keys are encrypted and stored securely. Keys marked "Using shared key" will use the system default.
          </p>
        </div>

        <div className="space-y-6">
          {/* OpenAI Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="openai-key" className="block text-sm font-medium text-gray-700">
                OpenAI API Key
              </label>
              {keyStatus && <StatusBadge status={keyStatus.openai} />}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Used for embeddings (semantic search)
            </p>
            <input
              type="password"
              id="openai-key"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={keyStatus?.openai.configured ? 'Enter new key to replace' : 'sk-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>

          {/* Anthropic Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="anthropic-key" className="block text-sm font-medium text-gray-700">
                Anthropic API Key
              </label>
              {keyStatus && <StatusBadge status={keyStatus.anthropic} />}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Used for summarization and script generation
            </p>
            <input
              type="password"
              id="anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={keyStatus?.anthropic.configured ? 'Enter new key to replace' : 'sk-ant-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>

          {/* ElevenLabs Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="elevenlabs-key" className="block text-sm font-medium text-gray-700">
                ElevenLabs API Key
                <span className="ml-2 text-xs text-gray-400 font-normal">(Optional)</span>
              </label>
              {keyStatus && <StatusBadge status={keyStatus.elevenlabs} />}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Premium TTS provider for high-quality voices
            </p>
            <input
              type="password"
              id="elevenlabs-key"
              value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
              placeholder={keyStatus?.elevenlabs.configured ? 'Enter new key to replace' : 'xi-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving || (!openaiKey && !anthropicKey && !elevenLabsKey)}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save API Keys'}
          </button>
        </div>
      </section>

      {/* Info Section */}
      <section className="bg-blue-50 rounded-lg border border-blue-200 p-6">
        <h3 className="text-sm font-medium text-blue-800">About API Keys</h3>
        <ul className="mt-2 text-sm text-blue-700 space-y-1">
          <li>• <strong>OpenAI</strong>: Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">platform.openai.com</a></li>
          <li>• <strong>Anthropic</strong>: Get your key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline">console.anthropic.com</a></li>
          <li>• <strong>ElevenLabs</strong>: Get your key at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="underline">elevenlabs.io</a></li>
        </ul>
      </section>
    </div>
  )
}
