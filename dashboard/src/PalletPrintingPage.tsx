import { useCallback, useEffect, useMemo, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import type { BridgeState } from './useBridge';
import type { PalletProduct } from './types';

type Notice = { kind: 'success' | 'error'; text: string } | null;

/** One pallet tag the bridge's durable print log says physically printed. */
type PalletPrint = {
  palletCode: string;
  batchRef: string | null;
  at: string | null;
  prints: number;
};

export default function PalletPrintingPage({ bridge }: { bridge: BridgeState }) {
  const workflow = bridge.palletWorkflow;
  const synced = Boolean(workflow && bridge.passageComplete?.passageId === workflow.passageId);
  const [printing, setPrinting] = useState(false);
  const [reprinting, setReprinting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [history, setHistory] = useState<PalletPrint[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (workflow?.type !== 'pallet-open') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [workflow?.type, workflow?.requestId]);

  const loadHistory = useCallback(async () => {
    try {
      const result = await readJson(await fetch(`${BRIDGE_HTTP}/printer/pallet-prints?limit=12`));
      setHistory(Array.isArray(result.prints) ? result.prints : []);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not read the print history.');
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Every pallet tag that prints — from this page or straight off the gate —
  // broadcasts a pallet-print message, so refetching on it keeps the list live
  // without polling the bridge.
  useEffect(() => {
    if (workflow?.type === 'pallet-print' && workflow.ok !== false) void loadHistory();
  }, [workflow?.type, workflow?.requestId, workflow?.ok, loadHistory]);

  const status = useMemo(() => {
    if (!workflow) return { label: 'WAITING FOR PALLET', tone: 'slate' };
    if (workflow.type === 'pallet-open') return { label: 'COLLECTING CARTONS', tone: 'cyan' };
    if (workflow.type === 'pallet-print' && workflow.ok === false) return { label: 'PRINT FAILED', tone: 'red' };
    if (synced) return { label: 'SYNCED TO NEXUS', tone: 'green' };
    if (workflow.type === 'pallet-print') return { label: 'PRINTED · NEXUS PENDING', tone: 'amber' };
    return { label: 'LABEL READY', tone: 'cyan' };
  }, [workflow, synced]);

  const secondsLeft = workflow?.type === 'pallet-open' && workflow.closesAt
    ? Math.max(0, Math.ceil((Date.parse(workflow.closesAt) - now) / 1000))
    : null;

  const closeAndPrint = async () => {
    if (!workflow || workflow.type !== 'pallet-open') return;
    setPrinting(true);
    setNotice(null);
    try {
      const response = await fetch(`${BRIDGE_HTTP}/movement/pallet/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: workflow.requestId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || `Bridge returned HTTP ${response.status}`);
      setNotice({ kind: 'success', text: `${workflow.palletCode} was closed and sent to the local printer.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not close the pallet.' });
    } finally {
      setPrinting(false);
    }
  };

  const sendPrint = async (body: Record<string, unknown>) =>
    readJson(await fetch(`${BRIDGE_HTTP}/printer/print-pallet-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

  /** Reprint the pallet currently sitting on the gate card. */
  const printCurrent = async () => {
    if (!workflow?.palletCode) return;
    setPrinting(true);
    setNotice(null);
    try {
      await sendPrint({
        palletCode: workflow.palletCode,
        jobId: workflow.requestId,
        passageId: workflow.passageId,
        cartonCount: workflow.cartonCount,
        queued: workflow.queued,
        force: true,
      });
      setNotice({ kind: 'success', text: `${workflow.palletCode} was sent to the pallet printer.` });
      void loadHistory();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Printing failed.' });
    } finally {
      setPrinting(false);
    }
  };

  /** Reprint an already-printed pallet, reproducing its original label. The
   *  jobId is deliberately unique per press: the bridge's idempotency guard
   *  exists to stop a pallet printing twice by accident, and a reprint is the
   *  one case where a second physical label is exactly what was asked for. */
  const reprint = async (entry: PalletPrint) => {
    setReprinting(entry.palletCode);
    setNotice(null);
    try {
      await sendPrint({
        palletCode: entry.palletCode,
        batchRef: entry.batchRef || undefined,
        jobId: `reprint:${entry.palletCode}:${Date.now()}`,
        passageId: 'reprint',
        cartonCount: 0,
        force: true,
      });
      setNotice({ kind: 'success', text: `${entry.palletCode} was reprinted.` });
      void loadHistory();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Reprint failed.' });
    } finally {
      setReprinting(null);
    }
  };

  const tone = status.tone === 'green'
    ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]'
    : status.tone === 'red'
      ? 'border-[#f0a1a2] bg-[#fef2f2] text-[#b41c1e]'
      : status.tone === 'amber'
        ? 'border-[#d97706] bg-[#fffbeb] text-[#b45309]'
        : status.tone === 'cyan'
          ? 'border-[#7fd9e4] bg-[#e0f7fa] text-[#008A9C]'
          : 'border-[#e5e5e5] bg-[#f5f5f5] text-[#737373]';

  return (
    <main className="gate-operator min-h-full bg-[#f5f5f5] p-6 text-[#0a0a0a] md:p-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <div>
            <div className="text-sm font-extrabold tracking-[0.18em] text-[#008A9C]">WAREHOUSE OPERATIONS</div>
            <h1 className="mt-1 text-3xl font-extrabold md:text-4xl">Pallet label printing</h1>
            <p className="mt-2 font-medium text-[#737373]">Print and reprint pallet labels without touching the GateBoard TV.</p>
          </div>
        </header>

        <section className="overflow-hidden rounded-2xl border border-[#e5e5e5] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e5] px-6 py-5">
            <h2 className="text-xl font-extrabold">Latest gate pallet</h2>
            <span className={`rounded-full border px-4 py-2 text-xs font-extrabold tracking-wider ${tone}`}>{status.label}</span>
          </div>
          <div className="p-6 md:p-8">
            {workflow ? (
              <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <div className="text-sm font-extrabold tracking-[0.08em] text-[#737373]">PALLET CODE</div>
                  <div className="mt-2 break-all text-2xl font-extrabold tracking-tight md:text-4xl">{workflow.palletCode}</div>
                  <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
                    <Metric label="Cartons" value={String(workflow.cartonCount)} />
                    <Metric label="Location" value="AMZ" />
                    <Metric label={workflow.type === 'pallet-open' ? 'Auto close' : 'Nexus'} value={workflow.type === 'pallet-open' ? `${secondsLeft ?? 0}s` : synced ? 'Synced' : workflow.queued ? 'Queued' : 'Sending'} />
                  </div>
                  <ProductLines products={workflow.products} cartonCount={workflow.cartonCount} />
                </div>
                <button disabled={printing} onClick={() => void (workflow.type === 'pallet-open' ? closeAndPrint() : printCurrent())} className="min-h-16 rounded-xl border border-[#008A9C] bg-[#00BCD4] px-8 py-4 text-lg font-extrabold text-white shadow-sm hover:bg-[#008A9C] disabled:cursor-wait disabled:opacity-60">
                  {printing ? 'Working…' : workflow.type === 'pallet-open' ? 'Close & print' : workflow.type === 'pallet-print' && workflow.ok === false ? 'Retry print' : 'Print again'}
                </button>
              </div>
            ) : (
              <div className="py-12 text-center text-[#737373]">
                <div className="text-xl font-extrabold text-[#0a0a0a]">No pallet detected yet</div>
                <div className="mt-2">The first received carton will open a new two-minute pallet.</div>
              </div>
            )}
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-2xl border border-[#e5e5e5] bg-white shadow-sm">
          <div className="border-b border-[#e5e5e5] px-6 py-5 md:px-8">
            <h2 className="text-xl font-extrabold">Previously printed</h2>
            <p className="mt-1 text-sm font-medium text-[#737373]">Reprint a label that was damaged or lost. The pallet keeps its original code.</p>
          </div>
          {historyError ? (
            <div className="px-6 py-10 text-center font-bold text-[#b41c1e] md:px-8">{historyError}</div>
          ) : history.length === 0 ? (
            <div className="px-6 py-12 text-center text-[#737373] md:px-8">
              <div className="text-xl font-extrabold text-[#0a0a0a]">{historyLoaded ? 'Nothing printed yet' : 'Loading…'}</div>
              {historyLoaded && <div className="mt-2">Pallet labels printed at the gate will appear here for reprinting.</div>}
            </div>
          ) : (
            <ul>
              {history.map((entry) => (
                <li key={entry.palletCode} className="flex flex-wrap items-center justify-between gap-4 border-b border-[#f5f5f5] px-6 py-5 last:border-b-0 md:px-8">
                  <div className="min-w-0">
                    <div className="break-all text-lg font-extrabold tracking-tight">{entry.palletCode}</div>
                    <div className="mt-1 text-sm font-medium text-[#737373]">
                      {printedAt(entry.at)}
                      {entry.batchRef ? ` · batch ${entry.batchRef}` : ''}
                      {entry.prints > 1 ? ` · printed ${entry.prints}×` : ''}
                    </div>
                  </div>
                  <button disabled={reprinting !== null} onClick={() => void reprint(entry)} className="min-h-12 shrink-0 rounded-xl border border-[#e5e5e5] bg-white px-6 font-extrabold text-[#0a0a0a] hover:border-[#00BCD4] hover:text-[#008A9C] disabled:cursor-not-allowed disabled:opacity-40">
                    {reprinting === entry.palletCode ? 'Printing…' : 'Reprint'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notice && <div className={`mx-6 mb-6 mt-6 rounded-xl border px-4 py-3 font-bold md:mx-8 ${notice.kind === 'success' ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]' : 'border-[#f0a1a2] bg-[#fef2f2] text-[#b41c1e]'}`}>{notice.text}</div>}
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm font-medium text-[#737373]">
          <span>Bridge: {bridge.wsConnected ? 'connected' : 'offline'}</span>
          <span>Printing stays local when Nexus or the internet is unavailable.</span>
        </footer>
      </div>
    </main>
  );
}

/** Read a bridge reply, never parsing blindly.
 *
 * A missing route answers with Express's HTML 404 page, and the reader-only
 * bridge (src/server-reader.js) deliberately carries NO /printer/* routes at
 * all — printing belongs to the gate bridge. Calling response.json() on that
 * HTML puts "Unexpected token '<'" in front of a warehouse operator, which
 * names the symptom and hides the cause. A 404 here has exactly one meaning
 * worth reporting: this page is pointed at a bridge that cannot print. */
async function readJson(response: Response) {
  const result = await response.json().catch(() => null);
  if (response.status === 404) {
    throw new Error('This bridge has no printer — pallet printing needs the gate bridge, not the reader-only build.');
  }
  if (!response.ok || result === null || result.ok === false) {
    throw new Error(result?.error || `Bridge returned HTTP ${response.status}`);
  }
  return result;
}

/** Time-of-day for today's prints, date + time for anything older — an operator
 *  reprinting a damaged label only needs to tell "this morning" from "last week". */
function printedAt(at: string | null) {
  if (!at) return 'Printed';
  const stamp = new Date(at);
  if (Number.isNaN(stamp.getTime())) return 'Printed';
  const time = stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = stamp.toDateString() === new Date().toDateString();
  return isToday ? `Printed ${time}` : `Printed ${stamp.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** What is actually on the pallet, per product. Hidden entirely when the bridge
 *  sent no breakdown (an older bridge, or a pallet with no cartons behind it) —
 *  an empty table would read as "no products", which is a different claim. */
function ProductLines({ products, cartonCount }: { products?: PalletProduct[]; cartonCount: number }) {
  if (!products?.length) return null;
  // The breakdown is built from the same entries as cartonCount, so a mismatch
  // means cartons were added between the two reads. Surfaced rather than hidden:
  // a silently short list is how an operator ships a pallet missing a carton.
  const counted = products.reduce((sum, p) => sum + p.cartons, 0);
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-extrabold tracking-[0.1em] text-[#737373]">PRODUCTS ON THIS PALLET</div>
        <div className="text-xs font-bold text-[#737373]">{products.length} {products.length === 1 ? 'product' : 'products'}</div>
      </div>
      <ul className="mt-2 divide-y divide-[#e5e5e5] overflow-hidden rounded-xl border border-[#e5e5e5]">
        {products.map((p) => (
          <li key={p.sku} className="flex items-center justify-between gap-4 bg-white px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-extrabold text-[#0a0a0a]">{p.name}</div>
              <div className="truncate text-xs font-bold tracking-wide text-[#737373]">{p.sku}</div>
            </div>
            <div className="shrink-0 text-right">
              <span className="text-xl font-extrabold text-[#0a0a0a]">{p.cartons}</span>
              <span className="ml-1 text-xs font-bold text-[#737373]">{p.cartons === 1 ? 'carton' : 'cartons'}</span>
            </div>
          </li>
        ))}
      </ul>
      {counted !== cartonCount && (
        <div className="mt-2 text-xs font-bold text-[#b45309]">
          Product lines total {counted} of {cartonCount} cartons — the pallet is still filling.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[#e5e5e5] bg-[#f5f5f5] p-4"><div className="text-xs font-extrabold tracking-wider text-[#737373]">{label.toUpperCase()}</div><div className="mt-1 text-lg font-extrabold text-[#0a0a0a]">{value}</div></div>;
}
