import { useEffect, useMemo, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import type { BridgeState } from './useBridge';

type Notice = { kind: 'success' | 'error'; text: string } | null;

export default function PalletPrintingPage({ bridge }: { bridge: BridgeState }) {
  const workflow = bridge.palletWorkflow;
  const synced = Boolean(workflow && bridge.passageComplete?.passageId === workflow.passageId);
  const [manualCode, setManualCode] = useState('');
  const [batchRef, setBatchRef] = useState('');
  const [printing, setPrinting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (workflow?.type !== 'pallet-open') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [workflow?.type, workflow?.requestId]);

  useEffect(() => {
    if (workflow?.palletCode) setManualCode(workflow.palletCode);
  }, [workflow?.palletCode]);

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

  const print = async (manual = false) => {
    const palletCode = (manual ? manualCode : workflow?.palletCode)?.trim().toUpperCase();
    if (!palletCode) return setNotice({ kind: 'error', text: 'Enter a pallet code first.' });
    setPrinting(true);
    setNotice(null);
    try {
      const body = manual
        ? { palletCode, batchRef: batchRef.trim().toUpperCase() || undefined, jobId: `manual-pallet:${palletCode}:${Date.now()}`, passageId: 'manual', cartonCount: 0, force: true }
        : { palletCode, batchRef: batchRef.trim().toUpperCase() || undefined, jobId: workflow!.requestId, passageId: workflow!.passageId, cartonCount: workflow!.cartonCount, queued: workflow!.queued, force: true };
      const response = await fetch(`${BRIDGE_HTTP}/printer/print-pallet-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || `Printer returned HTTP ${response.status}`);
      setNotice({ kind: 'success', text: `${palletCode} was sent to the pallet printer.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Printing failed.' });
    } finally {
      setPrinting(false);
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
                </div>
                <button disabled={printing} onClick={() => void (workflow.type === 'pallet-open' ? closeAndPrint() : print(false))} className="min-h-16 rounded-xl border border-[#008A9C] bg-[#00BCD4] px-8 py-4 text-lg font-extrabold text-white shadow-sm hover:bg-[#008A9C] disabled:cursor-wait disabled:opacity-60">
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

        <section className="mt-6 rounded-2xl border border-[#e5e5e5] bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-xl font-extrabold">Print by pallet code</h2>
          <p className="mt-1 text-sm font-medium text-[#737373]">Use this for an approved replacement label or a pallet prepared offline.</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="PLT-YIWU-MAIN-GATE-00000058" className="min-h-14 flex-1 rounded-xl border border-[#e5e5e5] bg-white px-4 text-lg font-bold uppercase tracking-wide outline-none focus:border-[#00BCD4] focus:ring-2 focus:ring-[#7fd9e4]" />
            <button disabled={printing || !manualCode.trim()} onClick={() => void print(true)} className="min-h-14 rounded-xl bg-[#0a0a0a] px-7 font-extrabold text-white hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-40">Print label</button>
          </div>
          <label className="mt-4 block">
            <span className="text-xs font-extrabold tracking-[0.1em] text-[#737373]">RECEIVING BATCH REFERENCE · OPTIONAL</span>
            <input value={batchRef} onChange={(event) => setBatchRef(event.target.value)} placeholder="RB-2026-0002" className="mt-2 min-h-12 w-full rounded-xl border border-[#e5e5e5] bg-white px-4 text-base font-bold uppercase tracking-wide outline-none focus:border-[#00BCD4] focus:ring-2 focus:ring-[#7fd9e4]" />
          </label>
          {notice && <div className={`mt-4 rounded-xl border px-4 py-3 font-bold ${notice.kind === 'success' ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]' : 'border-[#f0a1a2] bg-[#fef2f2] text-[#b41c1e]'}`}>{notice.text}</div>}
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm font-medium text-[#737373]">
          <span>Bridge: {bridge.wsConnected ? 'connected' : 'offline'}</span>
          <span>Printing stays local when Nexus or the internet is unavailable.</span>
        </footer>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[#e5e5e5] bg-[#f5f5f5] p-4"><div className="text-xs font-extrabold tracking-wider text-[#737373]">{label.toUpperCase()}</div><div className="mt-1 text-lg font-extrabold text-[#0a0a0a]">{value}</div></div>;
}
