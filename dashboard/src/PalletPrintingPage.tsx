import { useCallback, useEffect, useMemo, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import { fetchDocuments } from './documents';
import type { BridgeState } from './useBridge';
import type { PalletProduct } from './types';

type Notice = { kind: 'success' | 'error'; text: string } | null;

/** What a product looks like on screen, as the board feed resolves it. */
type ProductArt = { photoUrl: string | null; emoji: string | null };

/**
 * Operator-facing pallet name, e.g. "Pallet-319".
 *
 * The durable code (PLT-YIWU-MAIN-GATE-00000319) is what Nexus and the RFID tag
 * carry, and it stays the identity everywhere that matters. Nobody at a doorway
 * reads it aloud, though, so the screen shows the trailing sequence the same way
 * the printed label does (see palletCaption in bridge/src/printer/tspl.js) —
 * screen and label MUST agree or an operator holding the tag cannot match it to
 * the card in front of them.
 */
function palletName(code: string | null | undefined): string {
  if (!code) return 'Pallet';
  // Already the short form — show it exactly as the barcode carries it.
  if (/^PALLET-(?:[A-Z0-9]+-)?\d+$/i.test(code)) return code.toUpperCase();
  const match = String(code).match(/(\d+)$/);
  if (!match) return String(code);
  return `PALLET-${String(Number(match[1])).padStart(3, '0')}`;
}

/** One pallet tag the bridge's durable print log says physically printed. */
type PalletPrint = {
  palletCode: string;
  batchRef: string | null;
  at: string | null;
  prints: number;
};

/** The pallet-printer settings a test label will be produced on. */
type PalletPrinterInfo = {
  palletPrinterName: string;
  palletWidthMm: number;
  palletHeightMm: number;
  palletDpi: number;
  ready: boolean;
  detail: string | null;
};

export default function PalletPrintingPage({ bridge }: { bridge: BridgeState }) {
  const workflow = bridge.palletWorkflow;
  const noReceiving = bridge.entries.find((entry) => entry.direction === 'in' && entry.unexpected === 'no-open-batch') ?? null;
  const synced = Boolean(workflow && bridge.passageComplete?.passageId === workflow.passageId);
  const [printing, setPrinting] = useState(false);
  const [reprinting, setReprinting] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [history, setHistory] = useState<PalletPrint[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [physicalCount, setPhysicalCount] = useState('');
  const [testing, setTesting] = useState(false);
  const [testNotice, setTestNotice] = useState<Notice>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [printerCfg, setPrinterCfg] = useState<PalletPrinterInfo | null>(null);

  useEffect(() => {
    setPhysicalCount('');
  }, [workflow?.requestId]);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Record<string, ProductArt>>({});

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

  const loadPrinterCfg = useCallback(async () => {
    try {
      const result = await readJson(await fetch(`${BRIDGE_HTTP}/printer/status`));
      const cfg = result.config ?? {};
      setPrinterCfg({
        palletPrinterName: cfg.palletPrinterName ?? '',
        palletWidthMm: cfg.palletWidthMm ?? 0,
        palletHeightMm: cfg.palletHeightMm ?? 0,
        palletDpi: cfg.palletDpi ?? 0,
        ready: Boolean(result.palletReady),
        detail: result.palletDetail ?? null,
      });
      setCfgError(null);
    } catch (error) {
      setPrinterCfg(null);
      setCfgError(error instanceof Error ? error.message : 'Could not read the printer settings.');
    }
  }, []);

  useEffect(() => {
    void loadPrinterCfg();
  }, [loadPrinterCfg]);

  /** Product artwork, by SKU.
   *
   *  The pallet card's product lines come from the tag catalogue (sku, name,
   *  cartons — see productBreakdown in bridge/src/outbox.js), which carries no
   *  picture. Nexus already resolves one per receiving line and the bridge
   *  passes it through as photoUrl on every DocLine, so the board feed is the
   *  source of truth for it rather than a second lookup of our own.
   *
   *  Failure is deliberately silent: a missing photo falls back to the emoji or
   *  glyph, and a pallet an operator needs to print must never be held up by
   *  the picture next to it. */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const feed = await fetchDocuments();
        if (!live) return;
        const bySku: Record<string, ProductArt> = {};
        for (const doc of [...(feed.docs ?? []), ...(feed.pool ?? [])]) {
          for (const line of doc.lines ?? []) {
            const art = { photoUrl: line.photoUrl ?? null, emoji: line.emoji ?? null };
            // First non-empty wins — the same SKU on two batches is one product.
            if (!bySku[line.sku]?.photoUrl && (art.photoUrl || art.emoji)) bySku[line.sku] = art;
          }
        }
        setPhotos(bySku);
      } catch {
        /* no artwork this load — the lines render with their glyph fallback */
      }
    })();
    return () => { live = false; };
  }, [bridge.receivingResetAt]);

  // Escape closes the dialog. Bound only while it is open so the page does not
  // keep a listener for a dialog nobody is looking at.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  /** One sample label on the current settings — the bench check for a printer
   *  that was just re-mediaed or moved. Its own endpoint, not print-pallet-tag:
   *  a test label is not a pallet that exists, so it must never be able to
   *  claim a real pallet code's jobId in the durable print log. */
  const printTest = async () => {
    setTesting(true);
    setTestNotice(null);
    try {
      const result = await readJson(await fetch(`${BRIDGE_HTTP}/printer/pallet-test-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));
      setTestNotice({ kind: 'success', text: `Test label ${result.palletCode ?? ''} sent to ${result.target ?? 'the pallet printer'}.` });
      void loadHistory();
      void loadPrinterCfg();
    } catch (error) {
      setTestNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Test print failed.' });
    } finally {
      setTesting(false);
    }
  };

  // Every pallet tag that prints — from this page or straight off the gate —
  // broadcasts a pallet-print message, so refetching on it keeps the list live
  // without polling the bridge.
  //
  // It is also the ONLY place the outcome of "Close & print" is known: that
  // button closes the pallet over HTTP and the bridge prints afterwards, so the
  // reply to the close says nothing about the label. The broadcast is what turns
  // "closing…" into printed or failed.
  useEffect(() => {
    if (workflow?.type !== 'pallet-print') return;
    if (workflow.ok === false) {
      setNotice({ kind: 'error', text: `${palletName(workflow.palletCode)} did not print — ${workflow.error || 'the printer refused the job.'}` });
      return;
    }
    setNotice({ kind: 'success', text: `${palletName(workflow.palletCode)} printed.` });
    void loadHistory();
  }, [workflow?.type, workflow?.requestId, workflow?.ok, workflow?.palletCode, workflow?.error, loadHistory]);

  // Nexus reset the receiving. The open pallet card is already gone (useBridge
  // clears it), but this page also shows the print HISTORY, which is only
  // reloaded on mount and after a print — so it kept listing labels for a batch
  // that had just been emptied, with no way to refresh short of a reload.
  useEffect(() => {
    if (!bridge.receivingResetAt) return;
    setNotice({ kind: 'success', text: 'Receiving was reset in Nexus — this page has been refreshed.' });
    void loadHistory();
  }, [bridge.receivingResetAt, loadHistory]);

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
    const checked = Math.floor(Number(physicalCount));
    if (!Number.isFinite(checked) || checked < 1) {
      setNotice({ kind: 'error', text: 'Count the physical cartons and enter the total before confirming.' });
      return;
    }
    if (checked !== workflow.cartonCount) {
      setNotice({ kind: 'error', text: `Count mismatch: ${checked} physical, ${workflow.cartonCount} read by RFID. Keep receiving: re-run the pallet slowly or use Manual Receive for the missing cartons.` });
      return;
    }
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
      setNotice({ kind: 'success', text: `${palletName(workflow.palletCode)} closed — printing the label…` });
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
      setNotice({ kind: 'success', text: `${palletName(workflow.palletCode)} was sent to the pallet printer.` });
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
      setNotice({ kind: 'success', text: `${palletName(entry.palletCode)} was reprinted.` });
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
    <main className="gate-operator min-h-full bg-[#f5f5f5] p-4 text-[#0a0a0a] md:p-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5 flex items-start justify-between gap-4 md:mb-8">
          <div>
            <div className="text-sm font-extrabold tracking-[0.18em] text-[#008A9C]">WAREHOUSE OPERATIONS</div>
            <h1 className="mt-1 text-2xl font-extrabold md:text-4xl">Pallet label printing</h1>
            {/* The strapline explains the page, it does not run it — on a tablet
                that vertical space is better spent on the print button. */}
            <p className="mt-2 hidden font-medium text-[#737373] md:block">Print and reprint pallet labels without touching the GateBoard TV.</p>
          </div>
          <button
            onClick={() => { setSettingsOpen(true); void loadPrinterCfg(); }}
            title="Printer settings and test print"
            aria-label="Printer settings and test print"
            className="shrink-0 rounded-xl border border-[#e5e5e5] bg-white p-3 text-[#737373] shadow-sm hover:border-[#00BCD4] hover:text-[#008A9C]"
          >
            <GearIcon />
          </button>
        </header>

        {noReceiving && (
          <section className="mb-6 overflow-hidden rounded-2xl border-2 border-[#b91c1c] bg-white shadow-sm">
            <div className="bg-[#b91c1c] px-5 py-3 text-center text-lg font-black tracking-[0.12em] text-white">NO RECEIVING</div>
            <div className="p-5 md:flex md:items-center md:justify-between md:gap-6">
              <div>
                <div className="text-xl font-extrabold">{noReceiving.item?.name || noReceiving.item?.sku || noReceiving.epc}</div>
                <div className="mt-1 font-mono text-sm font-bold text-[#b91c1c]">{noReceiving.item?.sku || noReceiving.epc}</div>
                <p className="mt-3 text-sm font-medium text-[#737373]">This scan was not credited and is not on the pallet. Add the product to an active receiving batch in Nexus, refresh the gate documents, then scan the carton again.</p>
              </div>
              <div className="mt-4 shrink-0 rounded-xl border border-[#f0a1a2] bg-[#fef2f2] px-5 py-3 text-sm font-extrabold text-[#b41c1e] md:mt-0">Continue other receiving</div>
            </div>
          </section>
        )}

        <section className="overflow-hidden rounded-2xl border border-[#e5e5e5] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5e5] px-4 py-4 md:px-6 md:py-5">
            <h2 className="text-xl font-extrabold">Latest gate pallet</h2>
            <span className={`rounded-full border px-4 py-2 text-xs font-extrabold tracking-wider ${tone}`}>{status.label}</span>
          </div>
          <div className="p-4 md:p-8">
            {workflow ? (
              <div>
                {/* Pallet identity and the print button share the FIRST row, and
                    the product breakdown sits below both. It used to live inside
                    the left column, which made the row as tall as the product
                    list and pushed the button off a tablet screen — the one
                    control an operator came to this page to press must never
                    need a scroll to reach. */}
                <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-start md:gap-6">
                  <div>
                    <div className="text-sm font-extrabold tracking-[0.08em] text-[#737373]">PALLET</div>
                    <div className="mt-2 text-2xl font-extrabold tracking-tight md:text-4xl">{palletName(workflow.palletCode)}</div>
                    {/* The receiving batch is assigned by Nexus when the passage is
                        accepted, so it is genuinely unknown until that lands. Saying
                        so beats printing the raw code and letting it read as a batch. */}
                    <div className="mt-1 break-all text-sm font-medium text-[#737373]">
                      {workflow.batchRef ? `Batch ${workflow.batchRef}` : 'Batch not assigned yet'}
                    </div>
                  </div>
                  <button disabled={printing || (workflow.type === 'pallet-open' && Number(physicalCount) !== workflow.cartonCount)} onClick={() => void (workflow.type === 'pallet-open' ? closeAndPrint() : printCurrent())} className="min-h-16 w-full rounded-xl border border-[#008A9C] bg-[#00BCD4] px-8 py-4 text-lg font-extrabold text-white shadow-sm hover:bg-[#008A9C] disabled:cursor-not-allowed disabled:opacity-60 md:w-auto">
                    {printing ? 'Working…' : workflow.type === 'pallet-open' ? (Number(physicalCount) === workflow.cartonCount ? 'Confirm and print' : 'Verify carton count') : workflow.type === 'pallet-print' ? (workflow.ok === false ? 'Retry print' : 'Print again') : 'Print label'}
                  </button>
                </div>
                {/* No Location tile: the pallet has not been put away when this
                    label prints, so there is no location to state. A hardcoded
                    "AMZ" was a guess printed as a fact. */}
                <div className="mt-6 grid grid-cols-2 gap-4">
                  <Metric label="Cartons" value={String(workflow.cartonCount)} />
                  <Metric label={workflow.type === 'pallet-open' ? 'Auto close' : 'Nexus'} value={workflow.type === 'pallet-open' ? `${secondsLeft ?? 0}s` : synced ? 'Synced' : workflow.queued ? 'Queued' : 'Sending'} />
                </div>
                {workflow.type === 'pallet-open' && (
                  <label className="mt-4 block rounded-xl border border-[#d97706]/40 bg-[#fffbeb] p-4">
                    <span className="block text-sm font-extrabold text-[#92400e]">PHYSICAL CARTONS ON THIS PALLET</span>
                    <span className="mt-1 block text-sm font-medium text-[#737373]">Count by eye. The number must match RFID before confirmation.</span>
                    <input value={physicalCount} onChange={(e) => setPhysicalCount(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="Enter physical count" className="mt-3 min-h-12 w-full rounded-lg border border-[#d97706] bg-white px-4 text-lg font-extrabold outline-none focus:ring-2 focus:ring-[#f59e0b]" />
                    {physicalCount && Number(physicalCount) !== workflow.cartonCount && <span className="mt-2 block font-bold text-[#b41c1e]">Mismatch: RFID read {workflow.cartonCount}. Re-run slowly or manually receive the missing cartons; warehouse work continues.</span>}
                    {Number(physicalCount) === workflow.cartonCount && <span className="mt-2 block font-bold text-[#15803d]">Count verified.</span>}
                  </label>
                )}
                <ProductLines products={workflow.products} cartonCount={workflow.cartonCount} photos={photos} />
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
                    <div className="text-lg font-extrabold tracking-tight">{palletName(entry.palletCode)}</div>
                    <div className="mt-1 break-all text-sm font-medium text-[#737373]">
                      {entry.batchRef ? `Batch ${entry.batchRef}` : 'Batch not assigned'}
                      {` · ${printedAt(entry.at)}`}
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

      {settingsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSettingsOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Printer settings and test print" className="relative max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#e5e5e5] bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[#e5e5e5] px-6 py-5 md:px-8">
              <div>
                <h2 className="text-xl font-extrabold">Printer settings</h2>
                <p className="mt-1 text-sm font-medium text-[#737373]">The settings every pallet label is printed on.</p>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                aria-label="Close"
                className="shrink-0 rounded-xl border border-[#e5e5e5] bg-white px-3 py-2 text-lg font-extrabold leading-none text-[#737373] hover:border-[#00BCD4] hover:text-[#008A9C]"
              >
                ×
              </button>
            </div>

            <div className="p-6 md:p-8">
              {/* Shown beside the test button because a wrong queue or media size
                  is the usual reason a test label comes out wrong, and hunting it
                  down in another screen wastes stock. */}
              {printerCfg ? (
                <div className="grid grid-cols-2 gap-4">
                  <Metric label="Printer" value={printerCfg.palletPrinterName || '— none —'} />
                  <Metric label="Label size" value={`${printerCfg.palletWidthMm}×${printerCfg.palletHeightMm} mm`} />
                  <Metric label="Density" value={`${printerCfg.palletDpi} dpi`} />
                  <Metric label="Status" value={printerCfg.ready ? 'Ready' : 'Not ready'} />
                </div>
              ) : (
                <div className="font-bold text-[#737373]">{cfgError ?? 'Reading printer settings…'}</div>
              )}

              {printerCfg && !printerCfg.ready && printerCfg.detail && (
                <div className="mt-4 rounded-xl border border-[#f0a1a2] bg-[#fef2f2] px-4 py-3 font-bold text-[#b41c1e]">{printerCfg.detail}</div>
              )}

              <div className="mt-6 border-t border-[#e5e5e5] pt-6">
                <h3 className="text-lg font-extrabold">Test print</h3>
                <p className="mt-1 text-sm font-medium text-[#737373]">
                  Prints one sample label on the settings above. Use it after changing media or moving the printer.
                </p>
                <button
                  disabled={testing || !printerCfg}
                  onClick={() => void printTest()}
                  className="mt-4 min-h-14 w-full rounded-xl border border-[#008A9C] bg-[#00BCD4] px-7 text-lg font-extrabold text-white shadow-sm hover:bg-[#008A9C] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {testing ? 'Printing…' : 'Print test label'}
                </button>
                {testNotice && (
                  <div className={`mt-4 rounded-xl border px-4 py-3 font-bold ${testNotice.kind === 'success' ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]' : 'border-[#f0a1a2] bg-[#fef2f2] text-[#b41c1e]'}`}>{testNotice.text}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
function ProductLines({ products, cartonCount, photos }: { products?: PalletProduct[]; cartonCount: number; photos: Record<string, ProductArt> }) {
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
          <li key={p.sku} className="flex items-center gap-4 bg-white px-4 py-3">
            <ProductThumb art={photos[p.sku]} name={p.name} />
            <div className="min-w-0 flex-1">
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

/** Photo, then the product's own emoji, then its initials — the same precedence
 *  the GateBoard tiles use (see boardKit.tsx), so one product looks like itself
 *  on every screen in the warehouse. A broken image URL falls through to the
 *  same fallback rather than leaving a torn-image icon on the row. */
function ProductThumb({ art, name }: { art?: ProductArt; name: string }) {
  const [broken, setBroken] = useState(false);
  const photo = !broken ? art?.photoUrl : null;
  return (
    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-[#e5e5e5] bg-[#f5f5f5]">
      {photo ? (
        <img src={photo} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : art?.emoji ? (
        <span className="text-2xl leading-none">{art.emoji}</span>
      ) : (
        <span className="text-sm font-extrabold text-[#a3a3a3]">{initials(name)}</span>
      )}
    </div>
  );
}

/** Up to two letters standing in for a product with no picture yet. */
function initials(name: string): string {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '—';
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[#e5e5e5] bg-[#f5f5f5] p-4"><div className="text-xs font-extrabold tracking-wider text-[#737373]">{label.toUpperCase()}</div><div className="mt-1 text-lg font-extrabold text-[#0a0a0a]">{value}</div></div>;
}
