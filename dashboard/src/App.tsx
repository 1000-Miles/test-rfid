import { useCallback, useEffect, useState } from 'react';
import { useBridge } from './useBridge';
import { useAudioGate } from './useAudioGate';
import { useGateBoard, type CountOutcome } from './documents';
import GateBoard from './GateBoard';
import { chime } from './sound';
import ControlDrawer from './ControlDrawer';
import TvBoard from './TvBoard';
import PalletPrintingPage from './PalletPrintingPage';
import PowerCutRecoveryPage from './PowerCutRecoveryPage';

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

const ROUTES = { gate: '/gateboard', tv: '/tv', printing: '/printing', powerCut: '/power-cut' } as const;
type Route = keyof typeof ROUTES;

/** Change the URL without a reload, preserving ?bridge=<ip> and friends. */
function navigate(path: string, opts: { replace?: boolean } = {}) {
  const url = path + window.location.search;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** localStorage, defanged — see the note on `voiceOn`. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked — the toggle still works, it just won't survive a reload */
  }
}

const readLocation = () => ({
  pathname: window.location.pathname.replace(/\/+$/, '').toLowerCase() || '/',
  hash: window.location.hash,
});

export default function App() {
  const bridge = useBridge();
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
  const route: Route = location.hash === '#tv' || location.pathname === ROUTES.tv ? 'tv' : location.pathname === ROUTES.printing ? 'printing' : location.pathname === ROUTES.powerCut ? 'powerCut' : 'gate';

  // Give `/`, unknown paths and the legacy hash a real URL.
  useEffect(() => {
    if (location.pathname !== ROUTES[route] || location.hash) navigate(ROUTES[route], { replace: true });
  }, [route, location]);

  // --- the gate chime ---
  //
  // Spoken announcements are gone: the board's alert is the tone, which is what
  // actually carried across a warehouse and meant the same thing to English and
  // Mandarin speakers. This flag is what's left of that switch and now gates the
  // chime alone. The stored key is unchanged so nobody's existing mute is lost.
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
  //
  // Both accesses are wrapped, because `localStorage` is not merely empty on
  // iOS Safari with "Block All Cookies" on (or in Private Browsing) — the
  // property ACCESS THROWS a SecurityError. Thrown from a useState initialiser
  // it takes the whole app down before anything mounts, which on an iPad is a
  // black screen and nothing else. The preference is a nicety; the board is not.
  const [voiceOn, setVoiceOn] = useState(() => readStored('voiceMuted') !== '1');
  const toggleVoice = () =>
    setVoiceOn((on) => {
      const next = !on;
      writeStored('voiceMuted', next ? '0' : '1');
      return next;
    });
  const sound = useAudioGate(voiceOn);

  // Audio for a movement, decided by what the BOARD made of it rather than by
  // the raw passage:
  //
  //   counted — it belongs to a document today. The ONLY case that makes a
  //             sound, so a beep means "that one landed on the board" and
  //             nothing else has to be interpreted.
  //   everything else — silent, including contested exits and unrecognised
  //             tags. At a doorway those are the common case (pallet wrap,
  //             returnable crates, staff walking through), and a board that
  //             reacts to all of them is a board people stop hearing.
  const onOutcome = useCallback(
    (outcome: CountOutcome) => {
      if (!voiceOn) return;
      if (outcome.kind === 'counted') chime('ok');
    },
    [voiceOn]
  );
  const board = useGateBoard(bridge.entries, onOutcome, bridge.receivingResetAt);

  if (route === 'tv') return <TvBoard bridge={bridge} onExit={() => navigate(ROUTES.gate)} />;
  if (route === 'printing') return <PalletPrintingPage bridge={bridge} />;
  if (route === 'powerCut') return <PowerCutRecoveryPage />;

  return (
    <>
      <DeliveryAlarm movement={bridge.movement} />
      <GateBoard board={board} entries={bridge.entries} sound={sound} onOpenControls={() => setControlsOpen(true)} />
      <LastSaved movement={bridge.movement} />
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

function LastSaved({ movement }: { movement: ReturnType<typeof useBridge>['movement'] }) {
  const saved = movement?.lastAccepted;
  if (!saved) return null;
  const time = new Date(saved.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const identity = saved.palletCode ? `Pallet ${saved.palletCode}` : saved.epc ? `EPC ${saved.epc}` : 'Movement';
  const state = saved.unexpected ? 'SET ASIDE — NOT CREDITED' : saved.pending ? 'SAVED LOCALLY — NEXUS PENDING' : 'SAVED — NEXUS DELIVERED';
  return (
    <div role="status" style={{ position: 'fixed', zIndex: 9000, right: 18, bottom: 18, maxWidth: 620, borderRadius: 12, border: '1px solid #cbd5e1', background: '#fff', padding: '10px 14px', boxShadow: '0 6px 24px rgba(15,23,42,.14)', fontSize: 13, fontWeight: 700 }}>
      <span style={{ color: '#64748b', marginRight: 8 }}>LAST SAVED</span>
      {identity} · {time} · <span style={{ color: saved.unexpected ? '#b91c1c' : saved.pending ? '#b45309' : '#047857' }}>{state}</span>
      {saved.eventId && <span title={saved.eventId} style={{ display: 'block', marginTop: 3, color: '#94a3b8', fontFamily: 'monospace', fontSize: 10 }}>{saved.eventId}</span>}
    </div>
  );
}

function DeliveryAlarm({ movement }: { movement: ReturnType<typeof useBridge>['movement'] }) {
  if (!movement) return null;
  const age = movement.oldestPendingAt ? Date.now() - Date.parse(movement.oldestPendingAt) : 0;
  const journalBad = !movement.journal.healthy;
  const rejected = movement.deadLetters > 0;
  const critical = journalBad || rejected || age >= 30 * 60_000;
  const warning = movement.queueDepth > 0 && age >= 5 * 60_000;
  if (!critical && !warning) return null;
  const minutes = Math.max(1, Math.floor(age / 60_000));
  const detail = journalBad
    ? `Local saving failed: ${movement.journal.lastEnqueueError ?? 'electronic recording is unavailable'} — switch to the manual outage log now; keep unloading in arrival order and call IT`
    : rejected
      ? `${movement.deadLetters} movement event${movement.deadLetters === 1 ? '' : 's'} rejected — set aside the affected goods for supervisor review; continue receiving all other goods`
      : `${movement.queueDepth} movement event${movement.queueDepth === 1 ? '' : 's'} waiting ${minutes} minutes for Nexus — keep receiving; notify the supervisor and escalate to IT if the connection remains unavailable`;
  return (
    <div role="alert" aria-live="assertive" style={{ position: 'fixed', zIndex: 10000, top: 12, left: '50%', transform: 'translateX(-50%)', width: 'min(94vw, 1100px)', padding: '16px 22px', borderRadius: 14, background: critical ? '#991b1b' : '#92400e', color: 'white', boxShadow: '0 8px 30px rgba(0,0,0,.3)', fontWeight: 800, textAlign: 'center' }}>
      {journalBad ? 'MANUAL FALLBACK REQUIRED' : critical ? 'ACTION REQUIRED — WORK CONTINUES' : 'NEXUS OFFLINE — RECEIVING IS SAVED LOCALLY'} · {detail}
      {journalBad && <a href="/power-cut" style={{ marginLeft: 12, color: 'white', textDecoration: 'underline' }}>Open recovery checklist</a>}
    </div>
  );
}
