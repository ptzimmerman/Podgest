import { useState, useEffect, useRef } from 'react'
import { Link, Outlet, useNavigate } from 'react-router-dom'
import { authClient } from '../lib/auth'

const API_URL = 'https://api.podgest.app'

type UserInfo = {
  email: string
  displayName: string | null
  avatarUrl: string | null
}

export function Layout() {
  const navigate = useNavigate()
  const { data: session } = authClient.useSession()
  const [user, setUser] = useState<UserInfo | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(() => {
    // Initialize from localStorage as fallback
    if (typeof window !== 'undefined') {
      return localStorage.getItem('darkMode') === 'true'
    }
    return false
  })
  const menuRef = useRef<HTMLDivElement>(null)

  // Apply dark mode class to document
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    // Also keep localStorage as fallback
    localStorage.setItem('darkMode', String(darkMode))
  }, [darkMode])

  // Save dark mode preference to database when it changes
  useEffect(() => {
    if (!userId) return
    
    const saveDarkMode = async () => {
      try {
        await fetch(`${API_URL}/api/profile`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dark_mode: darkMode }),
        })
      } catch (err) {
        console.error('Failed to save dark mode preference:', err)
      }
    }
    
    saveDarkMode()
  }, [darkMode, userId])

  useEffect(() => {
    if (!session?.user) return

    setUserId(session.user.id)
    setUser({
      email: session.user.email || '',
      displayName: session.user.name || null,
      avatarUrl: session.user.image || null,
    })

    // Fetch dark mode preference from database
    const fetchDarkMode = async () => {
      try {
        const res = await fetch(`${API_URL}/api/profile`, { credentials: 'include' })
        if (!res.ok) return
        const { profile } = await res.json() as { profile: { dark_mode: boolean } }
        if (profile?.dark_mode !== null && profile?.dark_mode !== undefined) {
          setDarkMode(profile.dark_mode)
        }
      } catch (err) {
        console.error('Failed to fetch dark mode preference:', err)
      }
    }
    fetchDarkMode()
  }, [session?.user])

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSignOut = async () => {
    await authClient.signOut()
    navigate('/login')
  }

  const getInitials = (name: string | null, email: string) => {
    if (name) {
      const parts = name.split(' ')
      if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      }
      return name[0].toUpperCase()
    }
    return email[0].toUpperCase()
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <Link to="/activity" className="flex items-center gap-2">
              <span className="text-xl font-semibold text-gray-900 dark:text-white">Podgest</span>
            </Link>
            
            <div className="flex items-center gap-4">
              {/* Dark Mode Toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? (
                  <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                  </svg>
                )}
              </button>

              {/* User Menu */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen(!menuOpen)}
                  className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                >
                  {user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt="Profile"
                      className="w-8 h-8 rounded-full"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-sm font-medium">
                      {user ? getInitials(user.displayName, user.email) : '?'}
                    </div>
                  )}
                  <svg
                    className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Dropdown Menu */}
                {menuOpen && (
                  <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50">
                    <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {user?.displayName || 'User'}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {user?.email}
                      </p>
                    </div>
                    <button
                      onClick={handleSignOut}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-8">
            <NavLink to="/activity" darkMode={darkMode}>Activity</NavLink>
            <NavLink to="/settings" darkMode={darkMode}>Settings</NavLink>
            <NavLink to="/subscriptions" darkMode={darkMode}>Subscriptions</NavLink>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function NavLink({ to, children, darkMode }: { to: string; children: React.ReactNode; darkMode?: boolean }) {
  return (
    <Link
      to={to}
      className={`py-4 text-sm font-medium border-b-2 border-transparent transition-colors ${
        darkMode 
          ? 'text-gray-300 hover:text-white hover:border-gray-500' 
          : 'text-gray-600 hover:text-gray-900 hover:border-gray-300'
      }`}
    >
      {children}
    </Link>
  )
}
