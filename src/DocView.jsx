import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Printer, Loader2, RefreshCw } from "lucide-react";

const REF_ORDER = [
  ["tables", "Tabele"],
  ["endpoints", "Endpointi"],
  ["urls", "URL-ovi"],
  ["crons", "Kronovi"],
  ["messages", "RabbitMQ"],
  ["queries", "Upiti"],
];

const sGet = async (key) => {
  const r = await window.storage.get(key);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};

function Refs({ refs, print }) {
  const groups = REF_ORDER
    .map(([k, label]) => [k, label, refs?.[k] ?? []])
    .filter(([, , v]) => v.length > 0);
  if (!groups.length) return null;

  return (
    <div className={print ? "doc-refs" : "mt-2.5 space-y-1"}>
      {groups.map(([k, label, vals]) => (
        <div key={k} className={print ? "doc-ref-row" : "flex gap-2 text-xs items-start"}>
          <span className={print ? "doc-ref-label" : "text-slate-400 shrink-0 w-[4.5rem] pt-0.5"}>
            {label}
          </span>
          <div className={print ? "doc-ref-vals" : "flex flex-wrap gap-1"}>
            {vals.map((v, i) => (
              <code key={i}
                className={print ? (k === "queries" ? "doc-q" : "doc-chip")
                  : k === "queries"
                    ? "block w-full whitespace-pre-wrap font-mono text-[11px] leading-relaxed bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-slate-700"
                    : "px-1.5 py-0.5 rounded bg-slate-100 text-slate-700"}>
                {v}
              </code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DocView({ area }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [printing, setPrinting] = useState(false);

  const load = async () => {
    setEntries(null); setError(null);
    try {
      setEntries(await sGet(`doc-entries-${area}`) ?? []);
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  useEffect(() => { load(); }, [area]);

  const bySection = useMemo(() => {
    const map = new Map();
    for (const e of entries ?? []) {
      const s = e.section || "Ostalo";
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(e);
    }
    return [...map.entries()];
  }, [entries]);

  const allTasks = useMemo(
    () => [...new Set((entries ?? []).flatMap((e) => e.tasks ?? []))].sort(),
    [entries]
  );

  const doPrint = () => {
    setPrinting(true);
    document.body.classList.add("doc-printing");
    setTimeout(() => {
      window.print();
      document.body.classList.remove("doc-printing");
      setPrinting(false);
    }, 120);
  };

  if (error) {
    return (
      <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
        Dokument nije učitan: {error}
      </p>
    );
  }

  if (entries === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
        <Loader2 size={15} className="animate-spin" /> Učitavam…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm text-slate-600">Dokument za oblast „{area}" je još prazan.</p>
        <p className="text-xs text-slate-400 mt-1">
          Zapisi se pojave kad prihvatiš predloge u tabu Predlozi.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-slate-500">
          {entries.length} {entries.length === 1 ? "zapis" : "zapisa"} u {bySection.length}
          {bySection.length === 1 ? " sekciji" : " sekcije"}
        </span>
        {allTasks.length > 0 && (
          <span className="text-xs text-slate-400 font-mono truncate">
            {allTasks.join(", ")}
          </span>
        )}
        <button onClick={load}
          className="ml-auto text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
          <RefreshCw size={11} /> osveži
        </button>
        <button onClick={doPrint} disabled={printing}
          className="text-xs font-medium text-slate-600 hover:text-indigo-700 border border-slate-200 hover:border-indigo-300 rounded-lg px-2.5 py-1 flex items-center gap-1 transition-colors disabled:opacity-40">
          <Printer size={12} /> PDF
        </button>
      </div>

      {bySection.map(([section, items]) => (
        <div key={section} className="mb-6">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
            {section}
          </h3>
          <div className="space-y-3">
            {items.map((e) => (
              <div key={e.id} className="border-l-2 border-slate-200 pl-3">
                <p className="text-sm text-slate-800 leading-relaxed">{e.text}</p>
                <Refs refs={e.refs} />
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[11px] text-slate-400">
                  {(e.tasks ?? []).length > 0 && (
                    <span className="font-mono">{e.tasks.join(", ")}</span>
                  )}
                  {(e.sources ?? []).length > 0 && (
                    <span className="font-mono">
                      potvrđuje: {e.sources.map((s) => s.case_id).join(", ")}
                    </span>
                  )}
                  {e.version > 1 && <span>v{e.version}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ---- verzija za štampu / PDF ---- */}
      {createPortal(
        <div className="doc-print-report">
          <style>{`
            .doc-print-report { display: none; }
            @media print {
              body.doc-printing #root { display: none !important; }
              body.doc-printing .doc-print-report { display: block !important; }
              @page { margin: 16mm; }
              .doc-print-report { font-family: system-ui, sans-serif; color: #1e293b; font-size: 11px; }
              .doc-print-report h1 { font-size: 17px; margin: 0 0 2px; }
              .doc-print-report .sub { color: #64748b; font-size: 10px; margin-bottom: 16px; }
              .doc-print-report h2 { font-size: 11px; text-transform: uppercase;
                letter-spacing: .06em; color: #64748b; margin: 16px 0 6px;
                border-bottom: .5px solid #cbd5e1; padding-bottom: 3px; }
              .doc-entry { margin: 0 0 10px; padding-left: 8px;
                border-left: 2px solid #e2e8f0; break-inside: avoid; }
              .doc-entry p.t { margin: 0; font-size: 11.5px; line-height: 1.5; }
              .doc-refs { margin-top: 4px; }
              .doc-ref-row { display: flex; gap: 6px; margin: 1.5px 0; align-items: baseline; }
              .doc-ref-label { color: #94a3b8; width: 62px; flex-shrink: 0; font-size: 9.5px; }
              .doc-ref-vals { display: flex; flex-wrap: wrap; gap: 3px; }
              .doc-chip { font-family: ui-monospace, monospace; font-size: 9.5px;
                background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
              .doc-q { font-family: ui-monospace, monospace; font-size: 9px;
                white-space: pre-wrap; display: block; width: 100%;
                background: #f8fafc; border: .5px solid #e2e8f0;
                padding: 3px 5px; border-radius: 3px; line-height: 1.4; }
              .doc-meta { color: #94a3b8; font-size: 9px; margin-top: 3px; }
            }
          `}</style>
          <h1>Tehnička dokumentacija — {area}</h1>
          <p className="sub">
            {entries.length} zapisa · {new Date().toLocaleDateString("sr-RS")}
            {allTasks.length > 0 ? ` · ${allTasks.join(", ")}` : ""}
          </p>
          {bySection.map(([section, items]) => (
            <div key={section}>
              <h2>{section}</h2>
              {items.map((e) => (
                <div className="doc-entry" key={e.id}>
                  <p className="t">{e.text}</p>
                  <Refs refs={e.refs} print />
                  <p className="doc-meta">
                    {(e.tasks ?? []).join(", ")}
                    {(e.sources ?? []).length > 0
                      ? ` · potvrđuje: ${e.sources.map((s) => s.case_id).join(", ")}`
                      : ""}
                    {e.version > 1 ? ` · v${e.version}` : ""}
                  </p>
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
