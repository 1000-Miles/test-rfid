import { useState } from 'react';

export default function PowerCutRecoveryPage() {
  const [checks, setChecks] = useState([false, false, false, false]);
  const steps = [
    'Power and internet are both back; the bridge dashboard is reachable.',
    'The movement queue has drained. Anything scanned before the cut must not be entered manually.',
    'Only items marked NOT SCANNED on the warehouse outage sheet have been entered with Nexus “Manually receive”.',
    'Nexus totals match the warehouse outage sheet; pallet locations are assigned and a supervisor signed it.',
  ];
  return (
    <main className="min-h-screen bg-slate-100 p-6 text-slate-950">
      <div className="mx-auto max-w-3xl rounded-2xl bg-white p-7 shadow">
        <header className="border-b pb-4">
          <div className="text-xs font-extrabold uppercase tracking-[.18em] text-cyan-700">Nexus Receiving</div>
          <h1 className="mt-1 text-3xl font-extrabold">Power-cut recovery</h1>
          <p className="mt-2 font-semibold text-slate-600">Use the warehouse’s existing outage sheet during the power cut. Complete this check when systems return.</p>
        </header>
        <section className="mt-7 rounded-xl border p-5">
          <h2 className="text-xl font-extrabold">Recovery checklist</h2>
          <p className="mt-1 text-sm font-semibold text-slate-600">Do these in order when power returns. Do not manually enter the whole sheet.</p>
          <div className="mt-4 space-y-3">{steps.map((step, i) => <label key={step} className="flex gap-3 font-semibold"><input type="checkbox" checked={checks[i]} onChange={() => setChecks((v) => v.map((x,j)=>j===i?!x:x))} className="size-5" /><span>{i + 1}. {step}</span></label>)}</div>
          <div className={`mt-5 rounded-lg p-3 font-extrabold ${checks.every(Boolean) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{checks.every(Boolean) ? 'Recovery reconciled — continue with normal system recording.' : 'Recovery remains open while warehouse work continues.'}</div>
        </section>
      </div>
    </main>
  );
}
