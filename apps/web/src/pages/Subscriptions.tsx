import { useState } from 'react'

export function Subscriptions() {
  const [newFeedUrl, setNewFeedUrl] = useState('')

  const handleAddFeed = async () => {
    // TODO: Implement feed subscription
    console.log('Adding feed:', newFeedUrl)
    setNewFeedUrl('')
  }

  // Placeholder data
  const subscriptions = [
    { id: '1', title: 'Lex Fridman Podcast', feedUrl: 'https://lexfridman.com/feed/podcast/' },
    { id: '2', title: 'Huberman Lab', feedUrl: 'https://feeds.megaphone.fm/hubermanlab' },
    { id: '3', title: 'The Daily', feedUrl: 'https://feeds.simplecast.com/54nAGcIl' },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Subscriptions</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your podcast subscriptions. New episodes will be automatically transcribed and included in your daily digest.
        </p>
      </div>

      {/* Add Feed Section */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Podcast</h2>
        <div className="flex gap-3">
          <input
            type="url"
            value={newFeedUrl}
            onChange={(e) => setNewFeedUrl(e.target.value)}
            placeholder="Enter podcast RSS feed URL"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
          />
          <button
            onClick={handleAddFeed}
            disabled={!newFeedUrl}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </section>

      {/* Subscriptions List */}
      <section className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Your Podcasts</h2>
        </div>
        <ul className="divide-y divide-gray-200">
          {subscriptions.map((sub) => (
            <li key={sub.id} className="px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-900">{sub.title}</h3>
                <p className="mt-1 text-xs text-gray-500 truncate max-w-md">{sub.feedUrl}</p>
              </div>
              <button
                className="text-sm text-red-600 hover:text-red-800 transition-colors"
                onClick={() => console.log('Remove:', sub.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {subscriptions.length === 0 && (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-gray-500">No subscriptions yet. Add a podcast above to get started.</p>
          </div>
        )}
      </section>
    </div>
  )
}
