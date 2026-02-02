import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

type Subscription = {
  id: string
  podcast_title: string
  feed_url: string
  is_active: boolean
  priority: number
}

export function Subscriptions() {
  const [newFeedUrl, setNewFeedUrl] = useState('')
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    fetchSubscriptions()
  }, [])

  const fetchSubscriptions = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const { data, error } = await supabase
        .from('subscriptions')
        .select('id, podcast_title, feed_url, is_active, priority')
        .eq('user_id', session.user.id)
        .order('priority', { ascending: false })

      if (error) throw error
      setSubscriptions(data || [])
    } catch (err) {
      console.error('Error fetching subscriptions:', err)
      setMessage({ type: 'error', text: 'Failed to load subscriptions' })
    } finally {
      setLoading(false)
    }
  }

  const handleAddFeed = async () => {
    if (!newFeedUrl) return

    setAdding(true)
    setMessage(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      // Try to fetch the feed to get the title
      let title = 'Unknown Podcast'
      try {
        const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(newFeedUrl)}`
        const res = await fetch(proxyUrl)
        if (res.ok) {
          const data = await res.json()
          title = data.feed?.title || 'Unknown Podcast'
        }
      } catch {
        // Use URL as fallback title
        title = new URL(newFeedUrl).hostname
      }

      const { error } = await supabase
        .from('subscriptions')
        .insert({
          user_id: session.user.id,
          feed_url: newFeedUrl,
          podcast_title: title,
          is_active: true,
          priority: 1,
        })

      if (error) {
        if (error.code === '23505') {
          throw new Error('You are already subscribed to this podcast')
        }
        throw error
      }

      setNewFeedUrl('')
      setMessage({ type: 'success', text: `Added: ${title}` })
      await fetchSubscriptions()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to add podcast' })
    } finally {
      setAdding(false)
    }
  }

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    try {
      const { error } = await supabase
        .from('subscriptions')
        .update({ is_active: !currentActive })
        .eq('id', id)

      if (error) throw error
      await fetchSubscriptions()
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to update subscription' })
    }
  }

  const handleRemove = async (id: string, title: string) => {
    if (!confirm(`Remove "${title}" from your subscriptions?`)) return

    try {
      const { error } = await supabase
        .from('subscriptions')
        .delete()
        .eq('id', id)

      if (error) throw error
      setMessage({ type: 'success', text: `Removed: ${title}` })
      await fetchSubscriptions()
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to remove subscription' })
    }
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
        <h1 className="text-2xl font-bold text-gray-900">Subscriptions</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage your podcast subscriptions. New episodes will be automatically transcribed and included in your daily digest.
        </p>
      </div>

      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {message.text}
        </div>
      )}

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
            onKeyDown={(e) => e.key === 'Enter' && handleAddFeed()}
          />
          <button
            onClick={handleAddFeed}
            disabled={!newFeedUrl || adding}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {adding ? 'Adding...' : 'Add'}
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Tip: You can find RSS feed URLs on podcast websites or services like ListenNotes
        </p>
      </section>

      {/* Subscriptions List */}
      <section className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Your Podcasts</h2>
          <span className="text-sm text-gray-500">{subscriptions.length} subscriptions</span>
        </div>
        
        {subscriptions.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No subscriptions</h3>
            <p className="mt-1 text-sm text-gray-500">Get started by adding a podcast RSS feed above.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {subscriptions.map((sub) => (
              <li key={sub.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center space-x-4 flex-1 min-w-0">
                  <button
                    onClick={() => handleToggleActive(sub.id, sub.is_active)}
                    className={`flex-shrink-0 w-10 h-6 rounded-full transition-colors ${sub.is_active ? 'bg-indigo-600' : 'bg-gray-200'}`}
                    title={sub.is_active ? 'Click to pause' : 'Click to activate'}
                  >
                    <span
                      className={`block w-4 h-4 mt-1 rounded-full bg-white shadow transform transition-transform ${sub.is_active ? 'translate-x-5' : 'translate-x-1'}`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3 className={`text-sm font-medium truncate ${sub.is_active ? 'text-gray-900' : 'text-gray-500'}`}>
                      {sub.podcast_title}
                    </h3>
                    <p className="mt-0.5 text-xs text-gray-400 truncate">{sub.feed_url}</p>
                  </div>
                </div>
                <button
                  className="ml-4 text-sm text-red-600 hover:text-red-800 transition-colors"
                  onClick={() => handleRemove(sub.id, sub.podcast_title)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Popular Feeds */}
      <section className="bg-gray-50 rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Popular Podcast Feeds</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          {[
            { name: 'Lex Fridman Podcast', url: 'https://lexfridman.com/feed/podcast/' },
            { name: 'Huberman Lab', url: 'https://feeds.megaphone.fm/hubermanlab' },
            { name: 'The Daily (NYT)', url: 'https://feeds.simplecast.com/54nAGcIl' },
            { name: 'Pivot', url: 'https://feeds.megaphone.fm/pivot' },
          ].map((feed) => (
            <button
              key={feed.url}
              onClick={() => setNewFeedUrl(feed.url)}
              className="text-left px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors"
            >
              + {feed.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
