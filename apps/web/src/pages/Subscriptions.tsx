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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Subscriptions</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Manage your podcast subscriptions. New episodes will be automatically transcribed and included in your daily digest.
        </p>
      </div>

      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'}`}>
          {message.text}
        </div>
      )}

      {/* ListenNotes Recommendation */}
      <section className="bg-indigo-50 dark:bg-indigo-900/30 rounded-lg border border-indigo-200 dark:border-indigo-800 p-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-indigo-900 dark:text-indigo-300">Pro Tip: Use ListenNotes to curate your feed</h3>
            <p className="mt-1 text-sm text-indigo-700 dark:text-indigo-400">
              Instead of adding podcasts one by one, use{' '}
              <a 
                href="https://www.listennotes.com/listen/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="font-medium underline hover:text-indigo-900 dark:hover:text-indigo-200"
              >
                ListenNotes Listen Later
              </a>
              {' '}to create a custom playlist. Add all your favorite podcasts there, then paste just one RSS feed URL here. 
              It's the easiest way to manage multiple podcasts!
            </p>
          </div>
        </div>
      </section>

      {/* Add Feed Section */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Add Podcast Feed</h2>
        <div className="flex gap-3">
          <input
            type="url"
            value={newFeedUrl}
            onChange={(e) => setNewFeedUrl(e.target.value)}
            placeholder="Paste RSS feed URL from ListenNotes or any podcast"
            className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm bg-white dark:bg-gray-900 dark:text-white"
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
      </section>

      {/* Subscriptions List */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Your Podcasts</h2>
          <span className="text-sm text-gray-500 dark:text-gray-400">{subscriptions.length} subscriptions</span>
        </div>
        
        {subscriptions.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No subscriptions</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by adding a podcast RSS feed above.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {subscriptions.map((sub) => (
              <li key={sub.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center space-x-4 flex-1 min-w-0">
                  <button
                    onClick={() => handleToggleActive(sub.id, sub.is_active)}
                    className={`flex-shrink-0 w-10 h-6 rounded-full transition-colors ${sub.is_active ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    title={sub.is_active ? 'Click to pause' : 'Click to activate'}
                  >
                    <span
                      className={`block w-4 h-4 mt-1 rounded-full bg-white shadow transform transition-transform ${sub.is_active ? 'translate-x-5' : 'translate-x-1'}`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3 className={`text-sm font-medium truncate ${sub.is_active ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
                      {sub.podcast_title}
                    </h3>
                    <p className="mt-0.5 text-xs text-gray-400 truncate">{sub.feed_url}</p>
                  </div>
                </div>
                <button
                  className="ml-4 text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors"
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
      <section className="bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Popular Podcast Feeds</h3>
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
