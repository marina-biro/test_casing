import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Check, Pencil, RotateCcw, Loader2, FileText, AlertTriangle, Sparkles } from "lucide-react";

const REF_LABELS = {
  tables: "Tabele",
  endpoints: "Endpointi",
  urls: "URL-ovi",
  crons: "Kronovi",
  messages: "RabbitMQ",
  queries: "Upiti",
};

const AREAS = ["oglasi", "paketi", "diler"];

const KIND_META = {
  new:    { label: "Nov zapis",  cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  update: { label: "Izmena",     cls: "text-indigo-700 bg-indigo-50 border-indigo-200" },
  stale:  { label: "Zastarelo",  cls: "text-amber-700 bg-amber-50 border-amber-200" },
};

const sGet = async (key) => {
  const r = await window.storage.get(key);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};
const sSet = async (key, val) => {
  const r = await window.storage.set(key, JSON.stringify(val));
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};

// ---------------------------------------------------------------------------
// diff po recima preko LCS - da se vidi tacno sta se menja, ne samo da se menja
// ---------------------------------------------------------------------------
function wordDiff(before = "", after = "") {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  const n = a.length, m = b.length;

  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push("del", a[i]); i++; }
    else { push("add", b[j]); j++; }
  }
  while (i < n) { push("del", a[i]); i++; }
  while (j < m) { push("add", b[j]); j++; }
  return out;
}

function DiffText({ before, after }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <p className="text-sm leading-relaxed">
      {parts.map((p, i) =>
        p.type === "same" ? <span key={i}>{p.text}</span>
        : p.type === "del" ? <span key={i} className="bg-rose-100 text-rose-800 line-through decoration-rose-400">{p.text}</span>
        : <span key={i} className="bg-emerald-100 text-emerald-800">{p.text}</span>
      )}
    </p>
  );
}

function RefChips({ refs, onEdit }) {
  const groups = Object.entries(REF_LABELS)
    .map(([k, label]) => [k, label, (refs?.[k] ?? [])])
    .filter(([, , vals]) => vals.length > 0);

  if (!groups.length) {
    return <p className="text-xs text-slate-400 mt-2">Bez tehničkih referenci</p>;
  }
  return (
    <div className="mt-3 space-y-1.5">
      {groups.map(([k, label, vals]) => (
        <div key={k} className="flex gap-2 text-xs">
          <span className="text-slate-400 shrink-0 w-20 pt-0.5">{label}</span>
          <div className="flex flex-wrap gap-1">
            {vals.map((v, i) => (
              <code key={i}
                className={`px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 ${
                  k === "queries" ? "block w-full whitespace-pre-wrap font-mono text-[11px] leading-relaxed" : ""}`}>
                {v}
              </code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
export default function DocReview({ area: initialArea, task, suiteIds, userName, onClose, onSaved }) {
  const [area, setArea] = useState(initialArea || AREAS[0]);
  const [phase, setPhase] = useState("idle");   // idle | generating | review | saving | done
  const [proposals, setProposals] = useState([]);
  const [decisions, setDecisions] = useState({}); // id -> {action, text}
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState(null);

  // predlozi koji jos cekaju od ranijeg generisanja u ovoj oblasti
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending = await sGet(`doc-proposals-${area}`);
      if (cancelled) return;
      if (pending?.length) { setProposals(pending); setDecisions({}); setPhase("review"); }
      else { setProposals([]); setPhase("idle"); }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [area]);

  const generate = async () => {
    setPhase("generating"); setError(null); setMessage(null);
    try {
      const res = await sSet("doc-generate", { area, task, suite_ids: suiteIds });
      if (res?.error) throw new Error(res.error);
      if (!res?.proposals?.length) {
        setMessage(res?.message || "Nema novih predloga.");
        setPhase("idle");
        return;
      }
      setProposals(res.proposals);
      setDecisions({});
      if (res.mode === "offline") {
        setMessage("Offline režim: bez API ključa. Tekst zapisa je doslovan iz test case-a, "
          + "a protivrečnosti sa postojećim zapisima se ne otkrivaju.");
      }
      setPhase("review");
    } catch (e) {
      setError(e?.message || String(e));
      setPhase("idle");
    }
  };

  const setAction = (id, action, text) =>
    setDecisions((d) => ({ ...d, [id]: { action, ...(text !== undefined ? { text } : {}) } }));

  const acceptAll = () =>
    setDecisions(Object.fromEntries(proposals.map((p) => [p.id, { action: "accept" }])));

  const decided = proposals.filter((p) => decisions[p.id]).length;

  const save = async () => {
    setPhase("saving"); setError(null);
    try {
      const payload = {
        by: userName?.trim() || null,
        task: task?.trim() || null,
        decisions: proposals
          .filter((p) => decisions[p.id])
          .map((p) => ({ proposal_id: p.id, ...decisions[p.id] })),
      };
      const res = await sSet("doc-resolve", payload);
      if (res?.error) throw new Error(res.error);
      setResult(res);
      setPhase("done");
      onSaved?.(res);
    } catch (e) {
      // transakcija je ponistena, dokument je nepromenjen
      setError(e?.message || String(e));
      setPhase("review");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== "saving") onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col">

        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <FileText size={16} className="text-indigo-600" />
          <h2 className="text-sm font-semibold text-slate-800">Tehnička dokumentacija</h2>
          <span className="text-xs text-slate-400">
            {area}{task ? ` · ${task}` : ""}
          </span>
          <button onClick={onClose} disabled={phase === "saving"}
            className="ml-auto text-slate-400 hover:text-slate-600 disabled:opacity-30">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {error && (
            <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Nije sačuvano</p>
                <p className="text-xs mt-0.5 font-mono">{error}</p>
                <p className="text-xs mt-1">Dokument je nepromenjen — ništa nije upisano.</p>
              </div>
            </div>
          )}

          {message && (
            <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
              {message}
            </p>
          )}

          {phase === "idle" && (
            <div className="text-center py-8">
              <div className="flex items-center justify-center gap-2 mb-5">
                <span className="text-xs text-slate-500">Oblast</span>
                <select value={area} onChange={(e) => setArea(e.target.value)}
                  className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-200">
                  {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <p className="text-sm text-slate-600 mb-1">
                Čita test case-ove u statusu pass{task ? ` za ${task}` : ""} i predlaže izmene dokumentacije.
              </p>
              <p className="text-xs text-slate-400 mb-5">
                Zapisi u statusu fail se ne koriste — to su bugovi, ne ponašanje.
              </p>
              <button onClick={generate}
                className="inline-flex items-center gap-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 transition-colors">
                <Sparkles size={15} /> Generiši predloge
              </button>
            </div>
          )}

          {phase === "generating" && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <Loader2 size={15} className="animate-spin" /> Čitam test case-ove…
            </div>
          )}

          {(phase === "review" || phase === "saving") && proposals.map((p) => {
            const d = decisions[p.id];
            const meta = KIND_META[p.kind] ?? KIND_META.new;
            const isEditing = editing === p.id;
            const shownText = d?.text ?? p.proposed_text;

            return (
              <div key={p.id}
                className={`border rounded-lg p-4 transition-colors ${
                  d?.action === "reject" ? "border-slate-200 bg-slate-50 opacity-60"
                  : d ? "border-indigo-200 bg-indigo-50/30"
                  : "border-slate-200"}`}>

                <div className="flex items-center gap-2 mb-2.5">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${meta.cls}`}>
                    {meta.label}
                  </span>
                  <span className="text-xs text-slate-400">{p.section}</span>
                  {(p.sources ?? []).length > 0 && (
                    <span className="text-xs text-slate-400 font-mono">
                      {p.sources.map((s) => s.case_id).join(", ")}
                    </span>
                  )}
                  {d && (
                    <button onClick={() => { setDecisions(({ [p.id]: _, ...rest }) => rest); setEditing(null); }}
                      className="ml-auto text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                      <RotateCcw size={11} /> vrati
                    </button>
                  )}
                </div>

                {p.kind === "stale" ? (
                  <p className="text-sm text-slate-700 line-through decoration-amber-400">
                    {p.current_text}
                  </p>
                ) : isEditing ? (
                  <textarea autoFocus rows={3} defaultValue={shownText}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== p.proposed_text) setAction(p.id, "edit", v);
                      else if (v === p.proposed_text) setAction(p.id, "accept");
                      setEditing(null);
                    }}
                    className="w-full text-sm border border-indigo-300 rounded-lg p-2 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                ) : p.kind === "update" ? (
                  <DiffText before={p.current_text || ""} after={shownText} />
                ) : (
                  <p className="text-sm text-slate-700 leading-relaxed">{shownText}</p>
                )}

                {p.rationale && (
                  <p className="text-xs text-slate-500 mt-2 italic">{p.rationale}</p>
                )}

                {p.kind !== "stale" && <RefChips refs={d?.refs ?? p.proposed_refs} />}

                {!d && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => setAction(p.id, "accept")}
                      className="text-xs font-medium text-emerald-700 hover:bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1 flex items-center gap-1 transition-colors">
                      <Check size={12} /> Prihvati
                    </button>
                    {p.kind !== "stale" && (
                      <button onClick={() => setEditing(p.id)}
                        className="text-xs font-medium text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 flex items-center gap-1 transition-colors">
                        <Pencil size={12} /> Izmeni
                      </button>
                    )}
                    <button onClick={() => setAction(p.id, "reject")}
                      className="text-xs font-medium text-slate-500 hover:bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 flex items-center gap-1 transition-colors">
                      <X size={12} /> Odbij
                    </button>
                  </div>
                )}

                {d && (
                  <p className="text-xs font-medium mt-3 text-slate-500">
                    {d.action === "accept" ? "Prihvaćeno"
                      : d.action === "edit" ? "Ručno izmenjeno"
                      : "Odbijeno — neće se ponovo predlagati"}
                  </p>
                )}
              </div>
            );
          })}

          {phase === "done" && result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-medium text-emerald-800 flex items-center gap-1.5">
                <Check size={15} /> Dokumentacija sačuvana
              </p>
              <p className="text-xs text-emerald-700 mt-1.5">
                {result.novi} novih, {result.izmenjeni} izmenjenih,
                {" "}{result.arhivirani} arhiviranih, {result.odbijeni} odbijenih.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-200">
          {phase === "review" && (
            <>
              <span className="text-xs text-slate-500">
                {decided} / {proposals.length} odlučeno
              </span>
              {decided < proposals.length && (
                <button onClick={acceptAll}
                  className="text-xs font-medium text-slate-600 hover:text-indigo-700 underline">
                  Prihvati sve
                </button>
              )}
            </>
          )}
          {phase === "saving" && (
            <span className="text-xs text-slate-500 flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" /> Upisujem…
            </span>
          )}
          <button onClick={onClose} disabled={phase === "saving"}
            className="ml-auto text-sm text-slate-500 hover:text-slate-700 px-3 py-2 disabled:opacity-30">
            {phase === "done" ? "Zatvori" : "Odustani"}
          </button>
          {phase === "review" && (
            <button onClick={save} disabled={decided === 0}
              className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg px-4 py-2 transition-colors">
              Sačuvaj {decided}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
