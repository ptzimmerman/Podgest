import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

type Subscription = {
  id: string
  podcast_title: string
  feed_url: string
  is_active: boolean
  priority: number
  publication_frequency_days?: number | null
}

type ParsedPodcast = {
  title: string
  feed_url: string
  artwork_url?: string
  publication_frequency_days: number | null
}

type ParseFeedResponse = {
  feed_title: string
  feed_url: string
  artwork_url?: string
  episode_count: number
  publication_frequency_days: number | null
  is_aggregator: boolean
  detected_podcasts: ParsedPodcast[]
}

export function Subscriptions() {
  const [newFeedUrl, setNewFeedUrl] = useState('')
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  
  // Show toast with auto-dismiss
  const showToast = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setToastVisible(true)
    setTimeout(() => {
      setToastVisible(false)
      setTimeout(() => setMessage(null), 300)
    }, type === 'error' ? 5000 : 3000) // Errors stay longer
  }

  useEffect(() => {
    fetchSubscriptions()
  }, [])

  const fetchSubscriptions = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const { data, error } = await supabase
        .from('subscriptions')
        .select('id, podcast_title, feed_url, is_active, priority, publication_frequency_days')
        .eq('user_id', session.user.id)
        .order('priority', { ascending: false })

      if (error) throw error
      setSubscriptions(data || [])
    } catch (err) {
      console.error('Error fetching subscriptions:', err)
      showToast('error', 'Failed to load subscriptions')
    } finally {
      setLoading(false)
    }
  }

  const handleAddFeed = async () => {
    if (!newFeedUrl) return

    setAdding(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      // Use our parse-feed endpoint to analyze the feed
      const apiUrl = import.meta.env.VITE_API_URL || 'https://api.podgest.app'
      const parseRes = await fetch(`${apiUrl}/api/parse-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_url: newFeedUrl }),
      })
      
      if (!parseRes.ok) {
        const err = await parseRes.json() as { error?: string }
        throw new Error(err.error || 'Failed to parse feed')
      }
      
      const feedData = await parseRes.json() as ParseFeedResponse
      
      // If it's an aggregator (like ListenNotes Listen Later), add all detected podcasts
      if (feedData.is_aggregator && feedData.detected_podcasts.length > 0) {
        let addedCount = 0
        let skippedCount = 0
        
        for (const podcast of feedData.detected_podcasts) {
          // Skip podcasts where we couldn't get the original RSS URL
          if (podcast.feed_url.includes('listennotes.com')) {
            skippedCount++
            continue
          }
          
          const { error } = await supabase
            .from('subscriptions')
            .insert({
              user_id: session.user.id,
              feed_url: podcast.feed_url,
              podcast_title: podcast.title,
              artwork_url: podcast.artwork_url,
              publication_frequency_days: podcast.publication_frequency_days,
              is_active: true,
              priority: 1,
            })
          
          if (error) {
            if (error.code === '23505') {
              // Already subscribed, skip
              skippedCount++
              continue
            }
            console.error(`Failed to add ${podcast.title}:`, error)
          } else {
            addedCount++
          }
        }
        
        setNewFeedUrl('')
        if (addedCount > 0) {
          showToast('success', `Added ${addedCount} podcast${addedCount > 1 ? 's' : ''} from aggregator feed${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`)
        } else {
          showToast('error', 'No new podcasts to add (already subscribed or could not resolve RSS URLs)')
        }
      } else {
        // Regular feed - add single subscription
        const { error } = await supabase
          .from('subscriptions')
          .insert({
            user_id: session.user.id,
            feed_url: feedData.feed_url,
            podcast_title: feedData.feed_title,
            artwork_url: feedData.artwork_url,
            publication_frequency_days: feedData.publication_frequency_days,
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
        const freqText = feedData.publication_frequency_days 
          ? ` (publishes every ${feedData.publication_frequency_days.toFixed(1)} days)`
          : ''
        showToast('success', `Added: ${feedData.feed_title}${freqText}`)
      }
      
      await fetchSubscriptions()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to add podcast')
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
      showToast('error', 'Failed to update subscription')
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
      showToast('success', `Removed: ${title}`)
      await fetchSubscriptions()
    } catch (err) {
      showToast('error', 'Failed to remove subscription')
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
              onClick={async () => {
                setNewFeedUrl(feed.url)
                // Auto-add after setting URL
                setAdding(true)
                try {
                  const { data: { session } } = await supabase.auth.getSession()
                  if (!session) throw new Error('Not authenticated')
                  
                  const apiUrl = import.meta.env.VITE_API_URL || 'https://api.podgest.app'
                  const parseRes = await fetch(`${apiUrl}/api/parse-feed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ feed_url: feed.url }),
                  })
                  
                  if (!parseRes.ok) {
                    const err = await parseRes.json() as { error?: string }
                    throw new Error(err.error || 'Failed to parse feed')
                  }
                  
                  const feedData = await parseRes.json() as ParseFeedResponse
                  
                  const { error } = await supabase
                    .from('subscriptions')
                    .insert({
                      user_id: session.user.id,
                      feed_url: feedData.feed_url,
                      podcast_title: feed.name,
                      artwork_url: feedData.artwork_url,
                      publication_frequency_days: feedData.publication_frequency_days,
                      is_active: true,
                      priority: 1,
                    })

                  if (error) {
                    if (error.code === '23505') {
                      throw new Error('Already subscribed')
                    }
                    throw error
                  }

                  setNewFeedUrl('')
                  showToast('success', `Added: ${feed.name}`)
                  await fetchSubscriptions()
                } catch (err) {
                  showToast('error', err instanceof Error ? err.message : 'Failed to add')
                } finally {
                  setAdding(false)
                }
              }}
              disabled={adding}
              className="text-left px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors disabled:opacity-50"
            >
              + {feed.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
