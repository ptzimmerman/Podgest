import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const API_URL = import.meta.env.VITE_API_URL || 'https://podgest-api.pztest.workers.dev'

type KeyStatus = {
  openai: { configured: boolean; valid: boolean | null }
  anthropic: { configured: boolean; valid: boolean | null }
  elevenlabs: { configured: boolean; valid: boolean | null }
}

export function Settings() {
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [elevenLabsKey, setElevenLabsKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [copiedFeed, setCopiedFeed] = useState(false)
  const [copiedMcp, setCopiedMcp] = useState(false)

  useEffect(() => {
    fetchKeyStatus()
  }, [])

  const fetchKeyStatus = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      setUserId(session.user.id)

      const { data, error } = await supabase
        .from('user_api_keys')
        .select('openai_key_encrypted, anthropic_key_encrypted, elevenlabs_key_encrypted, openai_valid, anthropic_valid, elevenlabs_valid')
        .eq('user_id', session.user.id)
        .single()

      if (error && error.code !== 'PGRST116') throw error // PGRST116 = no rows

      const status: KeyStatus = {
        openai: { 
          configured: !!data?.openai_key_encrypted, 
          valid: data?.openai_valid ?? null 
        },
        anthropic: { 
          configured: !!data?.anthropic_key_encrypted, 
          valid: data?.anthropic_valid ?? null 
        },
        elevenlabs: { 
          configured: !!data?.elevenlabs_key_encrypted, 
          valid: data?.elevenlabs_valid ?? null 
        },
      }

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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
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
  const mcpServerUrl = 'https://podgest-mcp.pztest.workers.dev'

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Manage your Podgest configuration and integrations.
        </p>
      </div>

      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'}`}>
          {message.text}
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
            <input
              type="password"
              id="openai-key"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={keyStatus?.openai.configured ? 'Enter new key to replace' : 'sk-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
            />
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
            <input
              type="password"
              id="anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={keyStatus?.anthropic.configured ? 'Enter new key to replace' : 'sk-ant-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
            />
          </div>

          {/* ElevenLabs Key */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="elevenlabs-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                ElevenLabs API Key
                <span className="ml-2 text-xs text-gray-400 font-normal">(Optional)</span>
              </label>
              {keyStatus && <StatusBadge status={keyStatus.elevenlabs} />}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Premium TTS provider for high-quality voices
            </p>
            <input
              type="password"
              id="elevenlabs-key"
              value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
              placeholder={keyStatus?.elevenlabs.configured ? 'Enter new key to replace' : 'xi-...'}
              className="mt-2 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
            />
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
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
      <section className="bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">Where to get API keys</h3>
        <ul className="mt-2 text-sm text-blue-700 dark:text-blue-400 space-y-1">
          <li>• <strong>OpenAI</strong>: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline">platform.openai.com/api-keys</a></li>
          <li>• <strong>Anthropic</strong>: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline">console.anthropic.com/settings/keys</a></li>
          <li>• <strong>ElevenLabs</strong>: <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="underline">elevenlabs.io/app/settings/api-keys</a></li>
        </ul>
      </section>
    </div>
  )
}
