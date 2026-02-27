import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.podgest.app'

type Subscription = {
  id: string
  podcast_title: string
  feed_url: string
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

const POPULAR_PODCASTS = [
  { name: 'Lex Fridman Podcast', url: 'https://lexfridman.com/feed/podcast/', description: 'Deep conversations about AI, science, and humanity' },
  { name: 'Huberman Lab', url: 'https://feeds.megaphone.fm/hubermanlab', description: 'Science-based tools for everyday life' },
  { name: 'The Daily', url: 'https://feeds.simplecast.com/54nAGcIl', description: 'News from The New York Times' },
  { name: 'Pivot', url: 'https://feeds.megaphone.fm/pivot', description: 'Tech, business, and politics with Kara Swisher & Scott Galloway' },
  { name: 'Hard Fork', url: 'https://feeds.simplecast.com/l2i9YnTd', description: 'Tech news and culture from NYT' },
]

export function OnboardingPodcasts() {
  const navigate = useNavigate()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [newFeedUrl, setNewFeedUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSubscriptions()
  }, [])

  const fetchSubscriptions = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        navigate('/login')
        return
      }

      const { data, error } = await supabase
        .from('subscriptions')
        .select('id, podcast_title, feed_url')
        .eq('user_id', session.user.id)

      if (error) throw error
      setSubscriptions(data || [])
    } catch (err) {
      console.error('Error fetching subscriptions:', err)
    } finally {
      setLoading(false)
    }
  }

  const addPodcast = async (feedUrl: string, title?: string) => {
    setAdding(true)
    setError(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      // Use our parse-feed endpoint to analyze the feed
      const parseRes = await fetch(`${API_URL}/api/parse-feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_url: feedUrl }),
      })
      
      if (!parseRes.ok) {
        const err = await parseRes.json() as { error?: string }
        throw new Error(err.error || 'Failed to parse feed')
      }
      
      const feedData = await parseRes.json() as ParseFeedResponse
      
      // If it's an aggregator (like ListenNotes Listen Later), add all detected podcasts
      if (feedData.is_aggregator && feedData.detected_podcasts.length > 0) {
        let addedCount = 0
        
        for (const podcast of feedData.detected_podcasts) {
          // Skip podcasts where we couldn't get the original RSS URL
          if (podcast.feed_url.includes('listennotes.com')) continue
          
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
          
          if (!error) addedCount++
        }
        
        if (addedCount === 0) {
          throw new Error('Could not resolve any podcast RSS URLs from aggregator feed')
        }
      } else {
        // Regular feed - add single subscription
        const podcastTitle = title || feedData.feed_title || 'Unknown Podcast'
        
        const { error } = await supabase
          .from('subscriptions')
          .insert({
            user_id: session.user.id,
            feed_url: feedData.feed_url,
            podcast_title: podcastTitle,
            artwork_url: feedData.artwork_url,
            publication_frequency_days: feedData.publication_frequency_days,
            is_active: true,
            priority: 1,
          })

        if (error) {
          if (error.code === '23505') {
            throw new Error('Already subscribed to this podcast')
          }
          throw error
        }
      }

      setNewFeedUrl('')
      await fetchSubscriptions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add podcast')
    } finally {
      setAdding(false)
    }
  }

  const removePodcast = async (id: string) => {
    try {
      await supabase.from('subscriptions').delete().eq('id', id)
      await fetchSubscriptions()
    } catch (err) {
      console.error('Error removing subscription:', err)
    }
  }

  const handleAddCustom = () => {
    if (newFeedUrl) {
      addPodcast(newFeedUrl)
    }
  }

  const [finishing, setFinishing] = useState(false)

  const handleFinishSetup = async () => {
    setFinishing(true)
    
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        navigate('/login')
        return
      }

      // Generate welcome episode in the background
      fetch(`${API_URL}/api/generate-welcome`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      }).then(res => {
        if (res.ok) {
          console.log('Welcome episode generation triggered')
        }
      }).catch(err => {
        console.error('Failed to trigger welcome episode:', err)
      })

      // Navigate immediately - welcome episode generates in background
      navigate('/settings')
    } catch (err) {
      console.error('Error finishing setup:', err)
      navigate('/settings')
    }
  }

  const canContinue = subscriptions.length > 0

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="ml-2 text-sm text-gray-500">API Keys</span>
            </div>
            <div className="w-12 h-0.5 bg-indigo-600"></div>
            <div className="flex items-center">
              <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-white font-medium">2</div>
              <span className="ml-2 text-sm font-medium text-indigo-600">Podcasts</span>
            </div>
          </div>
        </div>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Subscribe to Podcasts</h1>
          <p className="mt-3 text-lg text-gray-600">
            Choose the podcasts you want in your daily digest. We'll transcribe new episodes and summarize the best insights for you.
          </p>
        </div>

        {/* ListenNotes Recommendation */}
        <div className="mb-8 bg-indigo-50 rounded-lg border border-indigo-200 p-5">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-indigo-900">Recommended: Use ListenNotes</h3>
              <p className="mt-1 text-sm text-indigo-700">
                The easiest way to add podcasts is with{' '}
                <a 
                  href="https://www.listennotes.com/listen/" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="font-medium underline hover:text-indigo-900"
                >
                  ListenNotes Listen Later
                </a>
                . Search for podcasts, add them to your playlist, then paste the single RSS feed URL below. 
                No need to hunt for individual feed URLs!
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
            {error}
          </div>
        )}

        {/* Current subscriptions */}
        {subscriptions.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Your Subscriptions ({subscriptions.length})</h2>
            <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
              {subscriptions.map((sub) => (
                <div key={sub.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-medium text-gray-900">{sub.podcast_title}</span>
                  <button
                    onClick={() => removePodcast(sub.id)}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Popular podcasts */}
        <div className="mb-8">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Popular Podcasts</h2>
          <div className="grid gap-3">
            {POPULAR_PODCASTS.map((podcast) => {
              const isSubscribed = subscriptions.some(s => s.feed_url === podcast.url)
              return (
                <div
                  key={podcast.url}
                  className={`bg-white rounded-lg border p-4 transition-colors ${
                    isSubscribed ? 'border-green-300 bg-green-50' : 'border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="text-sm font-medium text-gray-900">{podcast.name}</h3>
                      <p className="mt-1 text-xs text-gray-500">{podcast.description}</p>
                    </div>
                    {isSubscribed ? (
                      <span className="flex-shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        ✓ Added
                      </span>
                    ) : (
                      <button
                        onClick={() => addPodcast(podcast.url, podcast.name)}
                        disabled={adding}
                        className="flex-shrink-0 px-3 py-1 text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
                      >
                        + Add
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Custom feed */}
        <div className="mb-8">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Or add a custom RSS feed</h2>
          <div className="flex gap-3">
            <input
              type="url"
              value={newFeedUrl}
              onChange={(e) => setNewFeedUrl(e.target.value)}
              placeholder="https://example.com/podcast/feed.xml"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleAddCustom()}
            />
            <button
              onClick={handleAddCustom}
              disabled={!newFeedUrl || adding}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Tip: Find RSS feeds on podcast websites or use ListenNotes to search
          </p>
        </div>

        {/* Continue button */}
        <div className="mt-8 flex justify-between items-center">
          <button
            onClick={() => navigate('/onboarding/keys')}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back
          </button>
          <button
            onClick={handleFinishSetup}
            disabled={!canContinue || finishing}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              canContinue && !finishing
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-200 text-gray-500 cursor-not-allowed'
            }`}
          >
            {finishing ? 'Setting up...' : 'Finish Setup →'}
          </button>
        </div>

        {!canContinue && (
          <p className="mt-4 text-center text-sm text-gray-500">
            Add at least one podcast to continue
          </p>
        )}
      </div>
    </div>
  )
}
