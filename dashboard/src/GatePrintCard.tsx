import { useEffect, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import { palletName, readJson } from './PalletPrintingPage';
import type { BridgeState } from './useBridge';

/**
 * The one-tap print card on the gate board itself.
 *
 * The board is signage, but the gate's panel has touch — and the person who
 * just walked a pallet through it should not have to open another page to get
 * its label. So the card APPEARS when the bridge opens a pallet (the first
 * received carton does that) and follows the workflow through to printed:
 *
 *   pallet-open   — cartons still arriving. One tap closes the pallet now
 *                   instead of waiting out the auto-close window; the bridge
 *                   prints the label as part of closing.
 *   pallet-ready  — closed, label not printed. One tap prints it.
 *   pallet-print  — printed (tap again for a second label) or failed (the tap
 *                   is the retry).
 *
 * Deliberately NOT here: the physical-count verification the /printing page
 * enforces before closing. That page is the careful path; this card is the
 * one-tap path the floor asked for, and the label carries the bridge's own
 * carton count either way. The count shown on the card is that same figure,
 * so the operator sees what the label will say before tapping.
 *
 * The card expires with the board's own live panel: a label printed this
 * morning must not still offer PRINT AGAIN at lunchtime. Open and failed
 * states never expire — one still needs closing, the other still needs fixing.
 */
const PRINTED_HIDE_MS = 10 * 60_000;

export default function GatePrintCard({ bridge }: { bridge: BridgeState }) {
  const workflow = bridge.palletWorkflow;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One coarse clock serves the auto-close countdown and the printed-state
  // expiry; it only runs while there is a card to keep current.
  useEffect(() => {
    if (!workflow) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [workflow]);

  // A new pallet or a state change is a new subject — an old failure message
  // must not sit under a fresh pallet's button.
  useEffect(() => {
    setError(null);
  }, [workflow?.requestId, workflow?.type]);

  if (!workflow) return null;

  const failed = workflow.type === 'pallet-print' && workflow.ok === false;
  const printed = workflow.type === 'pallet-print' && !failed;
  const open = workflow.type === 'pallet-open';

  const stamp = Date.parse(workflow.timestamp ?? '');
  if (printed && Number.isFinite(stamp) && now - stamp > PRINTED_HIDE_MS) return null;

  const secondsLeft = open && workflow.closesAt ? Math.max(0, Math.ceil((Date.parse(workflow.closesAt) - now) / 1000)) : null;

  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      if (open) {
        // Closing prints: the bridge prints the label as part of the close, and
        // the outcome comes back as a pallet-print broadcast that moves this
        // card on its own — the close reply says nothing about the label.
        await readJson(
          await fetch(`${BRIDGE_HTTP}/movement/pallet/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: workflow.requestId }),
          })
        );
      } else {
        // Ready, printed-again and retry are all the same print. force: a
        // second tap on PRINT AGAIN is a person asking for a second physical
        // label, which is the one case the bridge's idempotency guard must not
        // swallow.
        await readJson(
          await fetch(`${BRIDGE_HTTP}/printer/print-pallet-tag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              palletCode: workflow.palletCode,
              batchRef: workflow.batchRef || undefined,
              jobId: printed ? `reprint:${workflow.palletCode}:${Date.now()}` : workflow.requestId,
              passageId: workflow.passageId,
              cartonCount: workflow.cartonCount,
              queued: workflow.queued,
              force: true,
            }),
          })
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The bridge refused the request.');
    } finally {
      setBusy(false);
    }
  };

  const look = failed
    ? { edge: '#f0a1a2', strip: '#b91c1c', label: 'PRINT FAILED' }
    : printed
      ? { edge: '#86d49f', strip: '#15803d', label: 'LABEL PRINTED' }
      : { edge: '#7fd9e4', strip: '#008A9C', label: open ? 'PALLET AT THE GATE' : 'LABEL READY' };

  return (
    <div className="fixed bottom-5 left-5 z-[85] w-[26rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border-2 bg-white shadow-2xl" style={{ borderColor: look.edge }}>
      <div className="px-5 py-2 text-center text-sm font-black tracking-[0.14em] text-white" style={{ background: look.strip }}>
        {look.label}
      </div>
      <div className="p-5">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0 truncate text-2xl font-extrabold tracking-tight text-[#0a0a0a]">{palletName(workflow.palletCode)}</div>
          <div className="shrink-0 text-right">
            <span className="text-2xl font-extrabold tabular-nums text-[#0a0a0a]">{workflow.cartonCount}</span>
            <span className="ml-1 text-xs font-bold text-[#737373]">{workflow.cartonCount === 1 ? 'CARTON' : 'CARTONS'}</span>
          </div>
        </div>
        <div className="mt-1 text-sm font-medium text-[#737373]">
          {open
            ? `Still collecting — auto closes in ${secondsLeft ?? 0}s`
            : failed
              ? workflow.error || 'The printer refused the job.'
              : workflow.batchRef
                ? `Batch ${workflow.batchRef}`
                : 'Batch not assigned yet'}
        </div>
        <button
          disabled={busy}
          onClick={() => void act()}
          className={`mt-4 min-h-16 w-full rounded-xl border px-6 text-xl font-extrabold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-60 ${
            failed ? 'border-[#991b1b] bg-[#b91c1c] hover:bg-[#991b1b]' : 'border-[#008A9C] bg-[#00BCD4] hover:bg-[#008A9C]'
          }`}
        >
          {busy ? 'Working…' : failed ? 'RETRY PRINT' : printed ? 'PRINT AGAIN' : open ? 'CLOSE & PRINT NOW' : 'PRINT LABEL'}
        </button>
        {error && <div className="mt-3 rounded-xl border border-[#f0a1a2] bg-[#fef2f2] px-4 py-2 text-sm font-bold text-[#b41c1e]">{error}</div>}
      </div>
    </div>
  );
}
