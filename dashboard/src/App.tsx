import { useEffect, useState } from 'react';
import { useBridge } from './useBridge';
import { useVoice } from './useVoice';
import { useAudioGate } from './useAudioGate';
import { useGateBoard } from './documents';
import GateBoard from './GateBoard';
import ControlDrawer from './ControlDrawer';
import TvBoard from './TvBoard';
import PalletPrintingPage from './PalletPrintingPage';

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

const ROUTES = { gate: '/gateboard', tv: '/tv', printing: '/printing' } as const;
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
  const route: Route = location.hash === '#tv' || location.pathname === ROUTES.tv ? 'tv' : location.pathname === ROUTES.printing ? 'printing' : 'gate';

  // Give `/`, unknown paths and the legacy hash a real URL.
  useEffect(() => {
    if (location.pathname !== ROUTES[route] || location.hash) navigate(ROUTES[route], { replace: true });
  }, [route, location]);

  // --- voice announcements on gate movements ---
  //
  // Default ON: this board's home is a wall-mounted TV that nobody can reach,
  // so silence has to be a deliberate choice, not the one you get by doing
  // nothing.
  //
  // Two things make that actually hold, both learned the hard way from the old
  // `voiceOn` key:
  //
  //  1. Only an explicit toggle is written. The old code persisted inside an
  //     effect keyed on the value, which runs on MOUNT — so merely opening the
  //     board once recorded a preference the user never expressed. Every
  //     browser that ever loaded the old build has `voiceOn: '0'` stored, which
  //     would then override any new default we chose.
  //  2. A new key, so those stale '0's are ignored rather than inherited. The
  //     stored value means MUTED, so "absent" reads as on without any special
  //     casing.
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('voiceMuted') !== '1');
  const toggleVoice = () =>
    setVoiceOn((on) => {
      const next = !on;
      localStorage.setItem('voiceMuted', next ? '0' : '1');
      return next;
    });
  useVoice(bridge.entries, voiceOn, bridge.gpi);
  const sound = useAudioGate(voiceOn);

  if (route === 'tv') return <TvBoard bridge={bridge} onExit={() => navigate(ROUTES.gate)} />;
  if (route === 'printing') return <PalletPrintingPage bridge={bridge} />;

  return (
    <>
      <GateBoard board={board} entries={bridge.entries} onOpenControls={() => setControlsOpen(true)} />
      <ControlDrawer
        open={controlsOpen}
        onClose={() => setControlsOpen(false)}
        bridge={bridge}
        board={board}
        voiceOn={voiceOn}
        onToggleVoice={toggleVoice}
        onOpenTv={() => navigate(ROUTES.tv)}
        onOpenPrinting={() => navigate(ROUTES.printing)}
      />
    </>
  );
}
