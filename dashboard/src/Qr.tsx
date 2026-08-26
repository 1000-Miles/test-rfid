import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, BRIDGE_PORT } from './api';
import { C, u } from './boardKit';

/**
 * "Scan to open this on your phone" — for a supervisor standing at the door
 * who wants the same live board on a handheld without walking to the kiosk.
 *
 * Encoded ENTIRELY CLIENT-SIDE (the `qrcode` package draws the SVG in-browser,
 * no network call at render time) so it keeps working if the warehouse WAN is
 * down — consistent with everything else on this kiosk.
 *
 * The one thing that DOES need a lookup is the target URL itself: the kiosk's
 * own `window.location` is usually http://localhost:5173/..., which means
 * nothing to a second device. The bridge runs on the same physical PC and can
 * read its real LAN IP via Node's os.networkInterfaces() (GET /network), so
 * that's what gets encoded instead.
 */
export default function Qr(props: { path?: string; size?: number }) {
  const size = props.size ?? 150;
  // A data: URL rendered through a plain <img>, not injected markup — the SVG
  // string form of this library needs dangerouslySetInnerHTML, which is worth
  // avoiding even when (as here) the content is self-generated and never
  // touches user input.
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ok, ip } = await api.network();
        if (!ok || !ip) throw new Error('no LAN address');
        const path = props.path ?? window.location.pathname;
        // Carry the bridge target along: with two gate bridges on one machine
        // (ports 3001/3002), a phone that opened gate 2's board must keep
        // talking to gate 2's bridge. The kiosk's own ?bridge= value can't be
        // reused verbatim — its host half is often 'localhost', meaningless on
        // the phone — so re-anchor it to the LAN IP plus the resolved port.
        const url = `${window.location.protocol}//${ip}:${window.location.port}${path}?bridge=${ip}:${BRIDGE_PORT}`;
        const png = await QRCode.toDataURL(url, { margin: 0, color: { dark: C.fg, light: '#ffffff' } });
        if (!cancelled) setDataUrl(png);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // Viewfinder corner ticks in the system's own cyan accent — a small, honest
  // detail that says "point a camera here" at a glance, rather than a plain
  // bordered square that could be mistaken for a placeholder or an icon tile.
  const tickLen = u(16);
  const tickW = u(3);
  const corner = (top: boolean, left: boolean) => ({
    position: 'absolute' as const,
    width: tickLen,
    height: tickLen,
    [top ? 'top' : 'bottom']: u(-2),
    [left ? 'left' : 'right']: u(-2),
    borderTop: top ? `${tickW} solid ${C.cyan}` : undefined,
    borderBottom: !top ? `${tickW} solid ${C.cyan}` : undefined,
    borderLeft: left ? `${tickW} solid ${C.cyan}` : undefined,
    borderRight: !left ? `${tickW} solid ${C.cyan}` : undefined,
    pointerEvents: 'none' as const,
  });

  return (
    <div
      style={{
        position: 'relative',
        flex: `0 0 ${u(size)}`,
        width: u(size),
        height: u(size),
        borderRadius: u(14),
        border: `1px solid ${C.border}`,
        background: C.white,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: u(10),
      }}
      title="Scan to open this board on your phone"
    >
      <div style={corner(true, true)} />
      <div style={corner(true, false)} />
      <div style={corner(false, true)} />
      <div style={corner(false, false)} />
      {dataUrl ? (
        <img src={dataUrl} alt="Scan to open this board on your phone" style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }} />
      ) : (
        <div style={{ fontSize: u(12), fontWeight: 600, color: C.faint, textAlign: 'center', lineHeight: 1.4, whiteSpace: 'pre-line' }}>
          {error ? 'QR unavailable\n(bridge offline)' : 'Loading QR…'}
        </div>
      )}
    </div>
  );
}
