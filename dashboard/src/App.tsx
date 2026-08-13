import { useEffect, useState } from 'react';
import { useBridge } from './useBridge';
import { useVoice } from './useVoice';
import { useGateBoard } from './documents';
import GateBoard from './GateBoard';
import ControlDrawer from './ControlDrawer';
import TvBoard from './TvBoard';

/**
 * Shell and router.
 *
 *   /gateboard — the gate board (landscape kiosk); also where `/` lands
 *   /tv        — the landscape TV wallboard; the old `#tv` hash still works
 *
 * The gear on the board opens the engineering console over whichever screen
 * is showing. Navigation is pushState-based so switching screens keeps the
 * bridge WebSocket and today's counts alive instead of reloading.
 *
 * Vite's dev server and preview fall back to index.html, so these paths work
 * without extra config; a production host needs the same SPA fallback.
 */

const ROUTES = { gate: '/gateboard', tv: '/tv' } as const;
type Route = keyof typeof ROUTES;

/** Change the URL without a reload, preserving ?bridge=<ip> and friends. */
function navigate(path: string, opts: { replace?: boolean } = {}) {
  const url = path + window.location.search;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const readLocation = () => ({
  pathname: window.location.pathname.replace(/\/+$/, '').toLowerCase() || '/',
  hash: window.location.hash,
});

export default function App() {
  const bridge = useBridge();
  const board = useGateBoard(bridge.entries);
  const [controlsOpen, setControlsOpen] = useState(false);

  // --- routing ---
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const sync = () => setLocation(readLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  // Route table. `#tv` is the legacy hash; anything unrecognised is the board.
  const route: Route = location.hash === '#tv' || location.pathname === ROUTES.tv ? 'tv' : 'gate';

  // Give `/`, unknown paths and the legacy hash a real URL.
  useEffect(() => {
    if (location.pathname !== ROUTES[route] || location.hash) navigate(ROUTES[route], { replace: true });
  }, [route, location]);

  // --- voice announcements on gate movements ---
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('voiceOn') === '1');
  useEffect(() => {
    localStorage.setItem('voiceOn', voiceOn ? '1' : '0');
  }, [voiceOn]);
  useVoice(bridge.entries, voiceOn);

  if (route === 'tv') return <TvBoard bridge={bridge} onExit={() => navigate(ROUTES.gate)} />;

  return (
    <>
      <GateBoard bridge={bridge} board={board} onOpenControls={() => setControlsOpen(true)} />
      <ControlDrawer
        open={controlsOpen}
        onClose={() => setControlsOpen(false)}
        bridge={bridge}
        board={board}
        voiceOn={voiceOn}
        onToggleVoice={() => setVoiceOn((v) => !v)}
        onOpenTv={() => navigate(ROUTES.tv)}
      />
    </>
  );
}
