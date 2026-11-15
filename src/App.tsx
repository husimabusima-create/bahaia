import { useState } from 'react';
import {
  CalendarClock,
  Clapperboard,
  Film,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AutomationPage } from './pages/AutomationPage';
import { CreateVideoPage } from './pages/CreateVideoPage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { VideoLibraryPage } from './pages/VideoLibraryPage';

type PageId = 'dashboard' | 'create' | 'library' | 'automation' | 'settings';

const NAV_ITEMS: Array<{ id: PageId; label: string; Icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'create', label: 'Create Video', Icon: Clapperboard },
  { id: 'library', label: 'Video Library', Icon: Film },
  { id: 'automation', label: 'Automation', Icon: CalendarClock },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

function parseHash(): { page: PageId; videoId: string | null } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [seg, id] = raw.split('/');
  if (seg === 'create') return { page: 'create', videoId: id || null };
  if (seg === 'library' || seg === 'automation' || seg === 'settings') {
    return { page: seg, videoId: null };
  }
  return { page: 'dashboard', videoId: null };
}

function AuthenticatedAppShell() {
  const { user, loading, sessionReady, signOutUser } = useAuth();
  const initial = parseHash();
  const [activePage, setActivePage] = useState<PageId>(initial.page);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(initial.videoId);
  const [createResetNonce, setCreateResetNonce] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (loading || (user && !sessionReady)) {
    return (
      <div className="min-h-screen bg-[#0B0C10] text-[#F4F5F7] flex flex-col items-center justify-center gap-3 px-4">
        <Loader2 className="w-6 h-6 text-rose-500 animate-spin" />
        <p className="text-xs font-mono text-zinc-400">Verifying authenticated ShortForge session...</p>
      </div>
    );
  }

  if (!user || !sessionReady) {
    return <LoginScreen />;
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activePage) ?? NAV_ITEMS[0];

  function updateHash(page: PageId, videoId: string | null = null) {
    const nextHash = page === 'create' && videoId ? `#create/${videoId}` : `#${page}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  function openCreateNew() {
    setSelectedVideoId(null);
    setCreateResetNonce((n) => n + 1);
    setActivePage('create');
    updateHash('create', null);
    setMobileNavOpen(false);
  }

  function openVideoScript(videoId: string) {
    setSelectedVideoId(videoId);
    setActivePage('create');
    updateHash('create', videoId);
    setMobileNavOpen(false);
  }

  function selectNav(page: PageId) {
    setActivePage(page);
    updateHash(page, page === 'create' ? selectedVideoId : null);
    setMobileNavOpen(false);
  }

  const userDisplay = user.displayName || user.email || 'Authenticated User';
  const userEmail = user.email || '';

  return (
    <div className="min-h-screen bg-[#0B0C10] text-[#F4F5F7] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0F1117] border-r border-white/[0.08]">
        <div className="h-16 px-6 flex items-center border-b border-white/[0.08]">
          <button
            type="button"
            onClick={() => selectNav('dashboard')}
            className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            Short<span className="text-rose-500">Forge</span>
          </button>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 px-3 py-5 space-y-1">
          {NAV_ITEMS.map(({ id, label, Icon }) => {
            const isActive = activePage === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => selectNav(id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-rose-600/15 text-white'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${isActive ? 'text-rose-500' : 'text-zinc-500'}`}
                  aria-hidden="true"
                />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/[0.08] space-y-3">
          <div className="text-xs text-zinc-500">
            <p className="font-medium text-zinc-300">Vertical 9:16 Studio</p>
            <p className="mt-0.5 font-mono">1080×1920 · H.264 / AAC</p>
          </div>
          <div className="pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200 truncate">{userDisplay}</p>
              {userEmail && userEmail !== userDisplay && (
                <p className="text-[11px] text-zinc-500 truncate">{userEmail}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void signOutUser()}
              title="Sign out"
              aria-label="Sign out"
              className="p-1.5 text-zinc-400 hover:text-rose-400 rounded-md hover:bg-white/[0.04] transition-colors shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-10 w-64 max-w-[80vw] bg-[#0F1117] border-r border-white/[0.08] flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/[0.08]">
              <span className="font-display text-lg font-bold tracking-tight text-white">
                Short<span className="text-rose-500">Forge</span>
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation menu"
                className="p-1.5 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {NAV_ITEMS.map(({ id, label, Icon }) => {
                const isActive = activePage === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectNav(id)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isActive
                        ? 'bg-rose-600/15 text-white'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 ${isActive ? 'text-rose-500' : 'text-zinc-500'}`}
                      aria-hidden="true"
                    />
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-white/[0.08] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-200 truncate">{userDisplay}</p>
                {userEmail && userEmail !== userDisplay && (
                  <p className="text-[11px] text-zinc-500 truncate">{userEmail}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void signOutUser()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-zinc-300 bg-[#181B24] border border-white/10 rounded-md hover:text-white cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 px-4 sm:px-8 border-b border-white/[0.08] bg-[#0B0C10]/90 backdrop-blur sticky top-0 z-30 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-zinc-400 hover:text-white cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-zinc-500 hidden sm:inline whitespace-nowrap">ShortForge</span>
              <span className="text-zinc-600 hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-medium text-white truncate">{activeNav.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden md:inline-block text-xs text-zinc-400 truncate max-w-[200px]">
              {userEmail}
            </span>
            <button
              type="button"
              onClick={openCreateNew}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              New Video
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-8 py-8 max-w-[1440px] w-full mx-auto">
          {activePage === 'dashboard' && (
            <DashboardPage
              onNavigateCreate={openCreateNew}
              onOpenVideoScript={openVideoScript}
              onNavigateLibrary={() => selectNav('library')}
              onNavigateSettings={() => selectNav('settings')}
            />
          )}
          {activePage === 'create' && (
            <CreateVideoPage
              selectedVideoId={selectedVideoId}
              resetNonce={createResetNonce}
              onVideoCreatedOrSelected={(id) => setSelectedVideoId(id)}
            />
          )}
          {activePage === 'library' && (
            <VideoLibraryPage
              onOpenEditor={openVideoScript}
              onNavigateCreate={openCreateNew}
            />
          )}
          {activePage === 'automation' && <AutomationPage />}
          {activePage === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedAppShell />
    </AuthProvider>
  );
}
