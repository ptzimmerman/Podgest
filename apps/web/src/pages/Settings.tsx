import { useState } from 'react'

export function Settings() {
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [elevenLabsKey, setElevenLabsKey] = useState('')

  const handleSave = async () => {
    // TODO: Implement API key saving
    console.log('Saving keys...')
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your API keys and preferences.
        </p>
      </div>

      {/* API Keys Section */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">API Keys</h2>
          <p className="mt-1 text-sm text-gray-500">
            Your API keys are encrypted and stored securely. They are used to generate your podcast digests.
          </p>
        </div>

        <div className="space-y-6">
          {/* OpenAI Key */}
          <div>
            <label htmlFor="openai-key" className="block text-sm font-medium text-gray-700">
              OpenAI API Key
            </label>
            <p className="mt-1 text-xs text-gray-500">
              Used for text-to-speech and embeddings
            </p>
            <input
              type="password"
              id="openai-key"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-..."
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>

          {/* Anthropic Key */}
          <div>
            <label htmlFor="anthropic-key" className="block text-sm font-medium text-gray-700">
              Anthropic API Key
            </label>
            <p className="mt-1 text-xs text-gray-500">
              Used for summarization and script generation
            </p>
            <input
              type="password"
              id="anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>

          {/* ElevenLabs Key */}
          <div>
            <label htmlFor="elevenlabs-key" className="block text-sm font-medium text-gray-700">
              ElevenLabs API Key
              <span className="ml-2 text-xs text-gray-400 font-normal">(Optional)</span>
            </label>
            <p className="mt-1 text-xs text-gray-500">
              Alternative TTS provider for higher quality voices
            </p>
            <input
              type="password"
              id="elevenlabs-key"
              value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
              placeholder="xi-..."
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
            />
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200">
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
          >
            Save API Keys
          </button>
        </div>
      </section>

      {/* Preferences Section */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">Preferences</h2>
          <p className="mt-1 text-sm text-gray-500">
            Customize your digest generation settings.
          </p>
        </div>

        <div className="space-y-6">
          {/* Timezone */}
          <div>
            <label htmlFor="timezone" className="block text-sm font-medium text-gray-700">
              Timezone
            </label>
            <select
              id="timezone"
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              defaultValue="America/Los_Angeles"
            >
              <option value="America/Los_Angeles">Pacific Time (PT)</option>
              <option value="America/Denver">Mountain Time (MT)</option>
              <option value="America/Chicago">Central Time (CT)</option>
              <option value="America/New_York">Eastern Time (ET)</option>
              <option value="Europe/London">London (GMT)</option>
              <option value="Europe/Paris">Paris (CET)</option>
            </select>
          </div>

          {/* Voice */}
          <div>
            <label htmlFor="voice" className="block text-sm font-medium text-gray-700">
              TTS Voice
            </label>
            <select
              id="voice"
              className="mt-2 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              defaultValue="alloy"
            >
              <option value="alloy">Alloy (Neutral)</option>
              <option value="echo">Echo (Male)</option>
              <option value="fable">Fable (British)</option>
              <option value="onyx">Onyx (Deep Male)</option>
              <option value="nova">Nova (Female)</option>
              <option value="shimmer">Shimmer (Soft Female)</option>
            </select>
          </div>
        </div>
      </section>
    </div>
  )
}
