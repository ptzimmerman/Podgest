import { useState, useEffect, useMemo } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.podgest.app'

type DigestEpisode = {
  id: string
  title: string | null
  podcast_title: string | null
  artwork_url: string | null
  audio_url: string | null
  published_at: string | null
  duration_seconds: number | null
}

type Digest = {
  id: string
  digest_date: string
  status: string
  audio_url: string | null
  duration_seconds: number | null
  error_message: string | null
  created_at: string
  completed_at: string | null
  episodes: DigestEpisode[]
}

const STATUS_STYLES: Record<string, { label: string; classes: string }> = {
  completed: { label: 'Completed', classes: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  failed: { label: 'Failed', classes: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
  pending: { label: 'Pending', classes: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' },
  processing: { label: 'Processing', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  transcribing: { label: 'Transcribing', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  generating_script: { label: 'Writing script', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  generating_audio: { label: 'Generating audio', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// digest_date is YYYY-MM-DD; parse as local date to avoid TZ shifting
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// The welcome episode is stored with a special 1970-01-01 date marker
function isWelcomeDigest(digest: Digest): boolean {
  return digest.digest_date === '1970-01-01'
}

// Welcome digests group by when they were created, not their 1970 marker date
function digestGroupDate(digest: Digest): Date {
  return isWelcomeDigest(digest) ? new Date(digest.created_at) : parseLocalDate(digest.digest_date)
}

function formatDigestDate(dateStr: string): string {
  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/** Monday of the week containing the given date, as a local Date */
function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = d.getDay() // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diff)
  return d
}

function weekLabel(start: Date): string {
  const now = new Date()
  const thisWeek = weekStart(now)
  const diffDays = Math.round((thisWeek.getTime() - start.getTime()) / 86400000)
  if (diffDays === 0) return 'This week'
  if (diffDays === 7) return 'Last week'
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const startStr = start.toLocaleDateString(undefined, opts)
  const endStr = end.toLocaleDateString(undefined, {
    ...opts,
    ...(start.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `Week of ${startStr} – ${endStr}`
}

type WeekGroup = {
  key: string
  label: string
  digests: Digest[]
}

export function Activity() {
  const [digests, setDigests] = useState<Digest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(new Set())
  const [openDigests, setOpenDigests] = useState<Set<string>>(new Set())

  useEffect(() => {
    const fetchDigests = async () => {
      try {
        const res = await fetch(`${API_URL}/api/digests`, { credentials: 'include' })
        if (!res.ok) throw new Error('Failed to load activity')
        const data = await res.json() as { digests: Digest[] }
        const list = data.digests || []
        setDigests(list)
        // Latest week expanded, latest digest card expanded
        if (list.length > 0) {
          setOpenWeeks(new Set([weekStart(digestGroupDate(list[0])).toISOString()]))
          setOpenDigests(new Set([list[0].id]))
        }
      } catch (err) {
        console.error('Error fetching digests:', err)
        setError('Failed to load activity. Please try again.')
      } finally {
        setLoading(false)
      }
    }
    fetchDigests()
  }, [])

  const weeks: WeekGroup[] = useMemo(() => {
    const groups = new Map<string, WeekGroup>()
    for (const digest of digests) {
      const start = weekStart(digestGroupDate(digest))
      const key = start.toISOString()
      if (!groups.has(key)) {
        groups.set(key, { key, label: weekLabel(start), digests: [] })
      }
      groups.get(key)!.digests.push(digest)
    }
    // API returns newest-first; Map preserves insertion order
    return [...groups.values()]
  }, [digests])

  const toggleWeek = (key: string) => {
    setOpenWeeks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleDigest = (id: string) => {
    setOpenDigests((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-sm text-red-800 dark:text-red-300">
        {error}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Activity</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your recent Podgest generations and the episodes they covered. Audio is kept for 7 days.
        </p>
      </div>

      {weeks.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            No digests yet. Your first Podgest will appear here after the next daily run.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {weeks.map((week) => {
            const weekOpen = openWeeks.has(week.key)
            return (
              <div
                key={week.key}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
              >
                {/* Week accordion header */}
                <button
                  onClick={() => toggleWeek(week.key)}
                  className="w-full flex items-center justify-between px-4 sm:px-5 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{week.label}</h2>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {week.digests.length} digest{week.digests.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${weekOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {weekOpen && (
                  <div className="border-t border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                    {week.digests.map((digest) => {
                      const digestOpen = openDigests.has(digest.id)
                      const status = STATUS_STYLES[digest.status] || {
                        label: digest.status,
                        classes: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
                      }
                      return (
                        <div key={digest.id}>
                          {/* Digest header row (click to expand) */}
                          <button
                            onClick={() => toggleDigest(digest.id)}
                            className="w-full flex items-center justify-between gap-2 px-4 sm:px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-white">
                                {isWelcomeDigest(digest) ? 'Welcome to Podgest' : formatDigestDate(digest.digest_date)}
                              </p>
                              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                {digest.completed_at
                                  ? `Generated ${formatTimestamp(digest.completed_at)}`
                                  : `Started ${formatTimestamp(digest.created_at)}`}
                                {digest.duration_seconds ? ` · ${formatDuration(digest.duration_seconds)} listen` : ''}
                                {digest.episodes.length > 0
                                  ? ` · ${digest.episodes.length} episode${digest.episodes.length === 1 ? '' : 's'}`
                                  : ''}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span
                                className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${status.classes} ${
                                  digest.status === 'failed' && digest.error_message ? 'cursor-help' : ''
                                }`}
                                title={
                                  digest.status === 'failed' && digest.error_message
                                    ? digest.error_message
                                    : undefined
                                }
                              >
                                {status.label}
                              </span>
                              <svg
                                className={`w-4 h-4 text-gray-400 transition-transform ${digestOpen ? 'rotate-180' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </button>

                          {digestOpen && (
                            <div className="px-4 sm:px-5 pb-4">
                              {/* Digest player (audio is purged after 7 days) */}
                              {digest.audio_url ? (
                                <audio
                                  controls
                                  preload="none"
                                  src={digest.audio_url}
                                  className="w-full h-10 mb-3"
                                />
                              ) : digest.status === 'completed' ? (
                                <p className="mb-3 text-xs text-gray-400 dark:text-gray-500 italic">
                                  Audio expired (kept for 7 days)
                                </p>
                              ) : null}

                              {/* Episodes covered */}
                              {digest.episodes.length > 0 && (
                                <ul className="rounded-lg border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                                  {digest.episodes.map((ep) => (
                                    <li key={`${digest.id}-${ep.id}`} className="px-3 py-2.5 flex items-center gap-3">
                                      {ep.artwork_url ? (
                                        <img
                                          src={ep.artwork_url}
                                          alt=""
                                          className="w-8 h-8 rounded flex-shrink-0 object-cover"
                                        />
                                      ) : (
                                        <div className="w-8 h-8 rounded flex-shrink-0 bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
                                          <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="currentColor" viewBox="0 0 20 20">
                                            <path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4z" />
                                            <path d="M5.5 9.643a.75.75 0 00-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-1.5v-1.546A6.001 6.001 0 0016 10v-.357a.75.75 0 00-1.5 0V10a4.5 4.5 0 01-9 0v-.357z" />
                                          </svg>
                                        </div>
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm text-gray-900 dark:text-white truncate">
                                          {ep.title || 'Untitled episode'}
                                        </p>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                          {ep.podcast_title || 'Unknown podcast'}
                                          {ep.duration_seconds ? ` · ${formatDuration(ep.duration_seconds)}` : ''}
                                        </p>
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
