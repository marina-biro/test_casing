import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, Trash2, ChevronUp, ChevronDown, Image as ImageIcon,
  FolderPlus, X, Clock, User, Save, Check
} from "lucide-react";

// ---------- status config ----------
const STATUSES = {
  created:      { label: "Kreiran",       dot: "bg-sky-500", chip: "bg-sky-50 text-sky-700 border-sky-200" },
  not_executed: { label: "Nije izvršen", dot: "bg-slate-300", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  pass:         { label: "Pass",          dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  fail:         { label: "Fail",          dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  review:       { label: "Traži proveru", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  blocked:      { label: "Blocked",       dot: "bg-slate-700", chip: "bg-slate-800 text-slate-100 border-slate-700" },
};

const ENVIRONMENTS = ["Chrome", "Firefox", "Safari", "Edge", "iPhone", "Android", "LambdaTest", "DEV", "STG", "PROD"];

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}. ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// resize pasted/uploaded screenshots so storage stays small
const resizeImage = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1000;
        let { width, height } = img;
        if (width > MAX) { height = Math.round((height * MAX) / width); width = MAX; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// ---------- storage helpers ----------
const sGet = async (key) => {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
};
const sSet = async (key, val) => {
  try { await window.storage.set(key, JSON.stringify(val)); return true; }
  catch (e) { console.error("storage set failed", e); return false; }
};
const sDel = async (key) => { try { await window.storage.delete(key); } catch {} };

const emptyCase = (suiteId, seq, by) => {
  const at = now();
  return {
    id: uid(),
    suiteId,
    caseId: `TC_${String(seq).padStart(3, "0")}`,
    title: "",
    objective: "",
    preconditions: "",
    testData: "",
    postconditions: "",
    environment: [],
    notes: "",
    steps: [{ id: uid(), action: "", expected: "", image: null }],
    actualResult: "",
    status: "created",
    createdBy: by,
    createdAt: at,
    executedBy: by,
    executedAt: at,
    history: [{ status: "created", by, at }],
  };
};

export default function QATestCaseTool() {
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [suites, setSuites] = useState([]);
  const [index, setIndex] = useState([]); // [{id, suiteId, caseId, title, status}]
  const [selectedId, setSelectedId] = useState(null);
  const [tc, setTc] = useState(null); // currently open full test case
  const [lightbox, setLightbox] = useState(null);
  const [saved, setSaved] = useState(true);
  const [addingSuite, setAddingSuite] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [view, setView] = useState("editor"); // "editor" | "table"
  const [allCases, setAllCases] = useState(null); // {id: fullCase} for table view
  const [tableLoading, setTableLoading] = useState(false);
  const [hoverPreview, setHoverPreview] = useState(null); // {src, x, y}
  const [envFilter, setEnvFilter] = useState(""); // "" = svi
  const saveTimer = useRef(null);

  // load all full cases when switching to table view
  const openTable = async () => {
    setView("table");
    setTableLoading(true);
    const entries = await Promise.all(index.map(async (c) => [c.id, await sGet(`tc-case-${c.id}`)]));
    setAllCases(Object.fromEntries(entries.filter(([, v]) => v)));
    setTableLoading(false);
  };

  // change status directly from the table (persists + records author/time)
  const setStatusInTable = async (id, status) => {
    const full = allCases?.[id];
    if (!full) return;
    const by = userName.trim() || "nepoznat korisnik";
    const at = now();
    const updated = { ...full, status, executedBy: by, executedAt: at,
      history: [{ status, by, at }, ...(full.history || [])].slice(0, 20) };
    setAllCases((p) => ({ ...p, [id]: updated }));
    await sSet(`tc-case-${id}`, updated);
    setIndex((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, status } : c));
      persistMeta(suites, next);
      return next;
    });
    if (tc && tc.id === id) setTc(updated);
  };

  const showPreview = (e, src) => setHoverPreview({ src, x: e.clientX, y: e.clientY });
  const hidePreview = () => setHoverPreview(null);

  // auto-reset delete confirmation after 3s
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const [u, meta] = await Promise.all([sGet("tc-user"), sGet("tc-meta")]);
      if (u) setUserName(u);
      if (meta) {
        let cases = meta.cases || [];
        // migration: older index entries don't carry environment — backfill from full cases
        const missing = cases.filter((c) => !("environment" in c));
        if (missing.length > 0) {
          const fulls = await Promise.all(missing.map((c) => sGet(`tc-case-${c.id}`)));
          const envMap = Object.fromEntries(missing.map((c, i) => [c.id, fulls[i]?.environment || []]));
          cases = cases.map((c) => ("environment" in c ? c : { ...c, environment: envMap[c.id] || [] }));
          sSet("tc-meta", { suites: meta.suites || [], cases });
        }
        setSuites(meta.suites || []);
        setIndex(cases);
      }
      setLoading(false);
    })();
  }, []);

  const persistMeta = useCallback((nextSuites, nextIndex) => {
    sSet("tc-meta", { suites: nextSuites, cases: nextIndex });
  }, []);

  // ---------- debounced save of open case ----------
  useEffect(() => {
    if (!tc) return;
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await sSet(`tc-case-${tc.id}`, tc);
      setIndex((prev) => {
        const next = prev.map((c) =>
          c.id === tc.id ? { ...c, title: tc.title, caseId: tc.caseId, status: tc.status, suiteId: tc.suiteId, environment: tc.environment } : c
        );
        persistMeta(suites, next);
        return next;
      });
      setSaved(true);
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [tc]); // eslint-disable-line

  // ---------- actions ----------
  const addSuite = () => {
    const name = newSuiteName.trim();
    if (!name) return;
    const next = [...suites, { id: uid(), name }];
    setSuites(next); persistMeta(next, index);
    setNewSuiteName(""); setAddingSuite(false);
  };

  const deleteSuite = (id) => {
    if (confirmDelete !== `suite-${id}`) { setConfirmDelete(`suite-${id}`); return; }
    setConfirmDelete(null);
    const doomed = index.filter((c) => c.suiteId === id);
    doomed.forEach((c) => sDel(`tc-case-${c.id}`));
    const nextS = suites.filter((s) => s.id !== id);
    const nextI = index.filter((c) => c.suiteId !== id);
    setSuites(nextS); setIndex(nextI); persistMeta(nextS, nextI);
    if (tc && tc.suiteId === id) { setTc(null); setSelectedId(null); }
  };

  const addCase = async (suiteId) => {
    const fresh = emptyCase(suiteId, index.length + 1, userName.trim() || "nepoznat korisnik");
    await sSet(`tc-case-${fresh.id}`, fresh);
    const nextI = [...index, { id: fresh.id, suiteId, caseId: fresh.caseId, title: "", status: "created", environment: [] }];
    setIndex(nextI); persistMeta(suites, nextI);
    setSelectedId(fresh.id); setTc(fresh);
  };

  const openCase = async (id) => {
    setSelectedId(id);
    const full = await sGet(`tc-case-${id}`);
    if (full) setTc(full);
  };

  const deleteCase = (id) => {
    if (confirmDelete !== `case-${id}`) { setConfirmDelete(`case-${id}`); return; }
    setConfirmDelete(null);
    sDel(`tc-case-${id}`);
    const nextI = index.filter((c) => c.id !== id);
    setIndex(nextI); persistMeta(suites, nextI);
    if (selectedId === id) { setTc(null); setSelectedId(null); }
  };

  const setField = (field, value) => setTc((p) => ({ ...p, [field]: value }));

  const setStatus = (status) => {
    const by = userName.trim() || "nepoznat korisnik";
    const at = now();
    setTc((p) => ({
      ...p, status, executedBy: by, executedAt: at,
      history: [{ status, by, at }, ...(p.history || [])].slice(0, 20),
    }));
  };

  // steps
  const setStep = (stepId, field, value) =>
    setTc((p) => ({ ...p, steps: p.steps.map((s) => (s.id === stepId ? { ...s, [field]: value } : s)) }));
  const addStep = () => setTc((p) => ({ ...p, steps: [...p.steps, { id: uid(), action: "", expected: "", image: null }] }));
  const removeStep = (stepId) => setTc((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== stepId) }));
  const moveStep = (i, dir) =>
    setTc((p) => {
      const steps = [...p.steps]; const j = i + dir;
      if (j < 0 || j >= steps.length) return p;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...p, steps };
    });

  const handlePaste = async (e, stepId) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const dataUrl = await resizeImage(item.getAsFile());
    setStep(stepId, "image", dataUrl);
  };

  const handleFile = async (e, stepId) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await resizeImage(f);
    setStep(stepId, "image", dataUrl);
    e.target.value = "";
  };

  const toggleEnv = (env) =>
    setTc((p) => {
      const has = p.environment.includes(env);
      return { ...p, environment: has ? p.environment.filter((x) => x !== env) : [...p.environment, env] };
    });

  const saveUser = (name) => { setUserName(name); sSet("tc-user", name); };

  // ---------- render ----------
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-mono text-sm">
        Učitavanje test slučajeva…
      </div>
    );
  }

  const filteredIndex = envFilter
    ? index.filter((c) => (c.environment || []).includes(envFilter))
    : index;
  const casesBySuite = (suiteId) => filteredIndex.filter((c) => c.suiteId === suiteId);
  const stat = (key) => filteredIndex.filter((c) => c.status === key).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* header */}
      <header className="bg-white border-b border-slate-200 px-5 py-3 flex items-center gap-4 sticky top-0 z-20">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold text-indigo-700 text-lg tracking-tight">TC/</span>
          <span className="font-semibold text-slate-900">Test Case Tool</span>
        </div>
        <div className="flex bg-slate-100 rounded-lg p-0.5 text-xs font-medium">
          <button onClick={() => setView("editor")}
            className={`px-3 py-1.5 rounded-md transition-colors ${view === "editor" ? "bg-white shadow-sm text-indigo-700" : "text-slate-500 hover:text-slate-700"}`}>
            Editor
          </button>
          <button onClick={openTable}
            className={`px-3 py-1.5 rounded-md transition-colors ${view === "table" ? "bg-white shadow-sm text-indigo-700" : "text-slate-500 hover:text-slate-700"}`}>
            Tabela
          </button>
        </div>
        <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}
          className={`text-xs rounded-lg border px-2 py-1.5 outline-none cursor-pointer ${
            envFilter ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium" : "border-slate-200 bg-white text-slate-500"}`}
          title="Filter po environmentu">
          <option value="">Env: svi</option>
          {ENVIRONMENTS.map((env) => (
            <option key={env} value={env}>{env}</option>
          ))}
        </select>
        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-slate-500 ml-2">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{stat("pass")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" />{stat("fail")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" />{stat("review")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-700" />{stat("blocked")}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            {saved ? <Check size={14} className="text-emerald-500" /> : <Save size={14} className="animate-pulse" />}
            <span>{saved ? "Sačuvano" : "Čuvam…"}</span>
          </div>
          <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5">
            <User size={14} className="text-slate-400" />
            <input
              className="bg-transparent text-sm outline-none w-32 placeholder-slate-400"
              placeholder="Tvoje ime…"
              value={userName}
              onChange={(e) => saveUser(e.target.value)}
            />
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* sidebar */}
        {view === "editor" && (
        <aside className="w-72 shrink-0 border-r border-slate-200 bg-white overflow-y-auto">
          <div className="p-3">
            {!addingSuite ? (
              <button onClick={() => setAddingSuite(true)}
                className="w-full flex items-center justify-center gap-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg py-2 transition-colors">
                <FolderPlus size={15} /> Nova funkcionalnost
              </button>
            ) : (
              <div className="flex gap-1.5">
                <input autoFocus value={newSuiteName}
                  onChange={(e) => setNewSuiteName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addSuite(); if (e.key === "Escape") { setAddingSuite(false); setNewSuiteName(""); } }}
                  placeholder="Naziv — npr. Plaćanje"
                  className="flex-1 min-w-0 text-sm border border-indigo-300 rounded-lg px-2.5 py-2 outline-none focus:border-indigo-500" />
                <button onClick={addSuite} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-2.5" title="Dodaj"><Check size={15} /></button>
                <button onClick={() => { setAddingSuite(false); setNewSuiteName(""); }} className="text-slate-400 hover:text-slate-600 px-1" title="Otkaži"><X size={15} /></button>
              </div>
            )}
          </div>
          {suites.length === 0 && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center leading-relaxed">
              Dodaj prvu funkcionalnost (suite) — npr. „Postavljanje oglasa" ili „Plaćanje" — pa u nju test slučajeve.
            </p>
          )}
          {suites.map((s) => (
            <div key={s.id} className="mb-1">
              <div className="group flex items-center px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <span className="truncate">{s.name}</span>
                <button onClick={() => addCase(s.id)} title="Dodaj test slučaj"
                  className="ml-auto opacity-0 group-hover:opacity-100 text-indigo-600 hover:text-indigo-800 p-1"><Plus size={14} /></button>
                <button onClick={() => deleteSuite(s.id)} title={confirmDelete === `suite-${s.id}` ? "Klikni ponovo za brisanje" : "Obriši suite"}
                  className={`p-1 ${confirmDelete === `suite-${s.id}` ? "opacity-100 text-rose-600" : "opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600"}`}>
                  {confirmDelete === `suite-${s.id}` ? <span className="text-[10px] font-bold normal-case">Sigurno?</span> : <Trash2 size={13} />}
                </button>
              </div>
              {casesBySuite(s.id).map((c) => (
                <button key={c.id} onClick={() => openCase(c.id)}
                  className={`w-full flex items-center gap-2 px-4 py-2 text-left text-sm border-l-2 transition-colors ${
                    selectedId === c.id ? "border-indigo-600 bg-indigo-50/60" : "border-transparent hover:bg-slate-50"}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUSES[c.status]?.dot || "bg-slate-300"}`} />
                  <span className="font-mono text-xs text-slate-400 shrink-0">{c.caseId}</span>
                  <span className="truncate text-slate-700">{c.title || "Bez naziva"}</span>
                </button>
              ))}
              {casesBySuite(s.id).length === 0 && (
                index.some((c) => c.suiteId === s.id) ? (
                  <p className="px-6 py-1.5 text-xs text-slate-300 italic">sakriveno filterom</p>
                ) : (
                  <button onClick={() => addCase(s.id)} className="w-full px-6 py-1.5 text-left text-xs text-indigo-500 hover:text-indigo-700">
                    + prvi test slučaj
                  </button>
                )
              )}
            </div>
          ))}
        </aside>
        )}

        {/* main */}
        <main className="flex-1 overflow-y-auto">
          {view === "table" ? (
            <TableView
              suites={suites}
              index={filteredIndex}
              allCases={allCases}
              loading={tableLoading}
              onStatusChange={setStatusInTable}
              onOpenCase={(id) => { setView("editor"); openCase(id); }}
              onShowPreview={showPreview}
              onHidePreview={hidePreview}
              onLightbox={setLightbox}
            />
          ) : !tc ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm">
              Izaberi test slučaj iz liste ili napravi novi.
            </div>
          ) : (
            <div className="max-w-4xl mx-auto p-6 space-y-5">
              {/* title row */}
              <div className="flex items-start gap-3">
                <input
                  className="font-mono text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 w-32 focus:border-indigo-400 outline-none"
                  value={tc.caseId} onChange={(e) => setField("caseId", e.target.value)} placeholder="TC_001" />
                <input
                  className="flex-1 text-lg font-semibold bg-white border border-slate-200 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none placeholder-slate-300"
                  value={tc.title} onChange={(e) => setField("title", e.target.value)}
                  placeholder='Naziv — npr. „Login sa validnim kredencijalima"' />
                <button onClick={() => deleteCase(tc.id)} title={confirmDelete === `case-${tc.id}` ? "Klikni ponovo za brisanje" : "Obriši"}
                  className={`p-2.5 rounded-lg border ${confirmDelete === `case-${tc.id}` ? "bg-rose-50 border-rose-300 text-rose-600 text-xs font-semibold" : "text-slate-400 hover:text-rose-600 bg-white border-slate-200"}`}>
                  {confirmDelete === `case-${tc.id}` ? "Sigurno?" : <Trash2 size={16} />}
                </button>
              </div>

              {/* status bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(STATUSES).map(([key, cfg]) => (
                    <button key={key} onClick={() => setStatus(key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                        tc.status === key ? cfg.chip + " ring-2 ring-offset-1 ring-indigo-300" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"}`}>
                      {cfg.label}
                    </button>
                  ))}
                  {tc.executedAt && (
                    <span className="ml-auto flex items-center gap-1.5 text-xs font-mono text-slate-500">
                      <Clock size={13} />
                      {STATUSES[tc.status].label} · {tc.executedBy} · {fmtTime(tc.executedAt)}
                    </span>
                  )}
                </div>
                {tc.createdAt && (
                  <p className="mt-2 text-xs font-mono text-slate-400">
                    Kreirao: {tc.createdBy} · {fmtTime(tc.createdAt)}
                  </p>
                )}
                {tc.history?.length > 1 && (
                  <details className="mt-3">
                    <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">Istorija statusa ({tc.history.length})</summary>
                    <ul className="mt-2 space-y-1">
                      {tc.history.map((h, i) => (
                        <li key={i} className="text-xs font-mono text-slate-500 flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${STATUSES[h.status]?.dot}`} />
                          {STATUSES[h.status]?.label} — {h.by} — {fmtTime(h.at)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {/* meta fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Test Objective" value={tc.objective} onChange={(v) => setField("objective", v)} placeholder="Svrha — npr. „Verifikuj uspešan login“" />
                <Field label="Preconditions" value={tc.preconditions} onChange={(v) => setField("preconditions", v)} placeholder="Preduslovi — npr. „User nalog postoji“" />
                <Field label="Test Data" value={tc.testData} onChange={(v) => setField("testData", v)} placeholder={"Email: user@test.com\nPass: 123456"} />
                <Field label="Postconditions" value={tc.postconditions} onChange={(v) => setField("postconditions", v)} placeholder="Stanje posle testa — npr. „Sesija aktivna“" />
              </div>

              {/* environment */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Test Environment</p>
                <div className="flex flex-wrap gap-2">
                  {ENVIRONMENTS.map((env) => (
                    <button key={env} onClick={() => toggleEnv(env)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        tc.environment.includes(env) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300"}`}>
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              {/* steps */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Test Steps</p>
                  <p className="ml-auto text-xs text-slate-400">Screenshot: Ctrl+V direktno u polje koraka</p>
                </div>
                <div className="space-y-3">
                  {tc.steps.map((s, i) => (
                    <div key={s.id} className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
                      <div className="flex gap-3">
                        <div className="flex flex-col items-center gap-1 pt-1">
                          <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 rounded-md w-7 h-7 flex items-center justify-center">{i + 1}</span>
                          <button onClick={() => moveStep(i, -1)} className="text-slate-300 hover:text-slate-600"><ChevronUp size={14} /></button>
                          <button onClick={() => moveStep(i, 1)} className="text-slate-300 hover:text-slate-600"><ChevronDown size={14} /></button>
                        </div>
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2">
                          <textarea rows={2} value={s.action}
                            onChange={(e) => setStep(s.id, "action", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id)}
                            placeholder="Akcija — npr. „Unesi email, klikni Login“"
                            className="text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-300" />
                          <textarea rows={2} value={s.expected}
                            onChange={(e) => setStep(s.id, "expected", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id)}
                            placeholder="Expected — npr. „Redirect na dashboard“"
                            className="text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-300" />
                        </div>
                        <div className="flex flex-col gap-1 items-end">
                          <label className="cursor-pointer text-slate-400 hover:text-indigo-600 p-1" title="Dodaj sliku">
                            <ImageIcon size={16} />
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e, s.id)} />
                          </label>
                          <button onClick={() => removeStep(s.id)} className="text-slate-300 hover:text-rose-500 p-1" title="Obriši korak">
                            <X size={15} />
                          </button>
                        </div>
                      </div>
                      {s.image && (
                        <div className="mt-2 ml-10 inline-flex items-center gap-1">
                          <button
                            onMouseEnter={(e) => showPreview(e, s.image)}
                            onMouseMove={(e) => showPreview(e, s.image)}
                            onMouseLeave={hidePreview}
                            onClick={() => { hidePreview(); setLightbox(s.image); }}
                            className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md px-2 py-1">
                            <ImageIcon size={13} /> screenshot
                          </button>
                          <button onClick={() => setStep(s.id, "image", null)}
                            className="text-slate-300 hover:text-rose-500 p-0.5" title="Ukloni sliku">
                            <X size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button onClick={addStep}
                  className="mt-3 flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
                  <Plus size={15} /> Dodaj korak
                </button>
              </div>

              {/* actual result + notes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Actual Result" value={tc.actualResult} onChange={(v) => setField("actualResult", v)} placeholder="Šta se stvarno desilo…" />
                <Field label="Notes / Comments" value={tc.notes} onChange={(v) => setField("notes", v)} placeholder="Dodatne napomene — npr. „UI spor, attach screenshot“" />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* hover image preview */}
      {hoverPreview && (
        <div className="fixed z-40 pointer-events-none"
          style={{
            left: Math.min(hoverPreview.x + 16, window.innerWidth - 340),
            top: Math.min(hoverPreview.y + 16, window.innerHeight - 260),
          }}>
          <img src={hoverPreview.src} alt="Preview" className="max-w-xs max-h-56 rounded-lg border border-slate-300 shadow-xl bg-white" />
        </div>
      )}

      {/* lightbox */}
      {lightbox && (
        <div className="fixed inset-0 bg-slate-900/80 z-50 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Screenshot" className="max-w-full max-h-full rounded-xl shadow-2xl" />
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{label}</p>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full text-sm bg-transparent outline-none resize-y placeholder-slate-300" />
    </div>
  );
}

const COLS = [
  ["Test Case ID", "w-28"],
  ["Test Case", "min-w-[180px]"],
  ["Test Objective", "min-w-[160px]"],
  ["Preconditions", "min-w-[150px]"],
  ["Test Steps", "min-w-[260px]"],
  ["Test Data", "min-w-[140px]"],
  ["Expected Result", "min-w-[200px]"],
  ["Actual Result", "min-w-[150px]"],
  ["Status", "w-40"],
  ["Postconditions", "min-w-[140px]"],
  ["Environment", "min-w-[120px]"],
  ["Notes", "min-w-[140px]"],
];

function TableView({ suites, index, allCases, loading, onStatusChange, onOpenCase, onShowPreview, onHidePreview, onLightbox }) {
  if (loading || !allCases) {
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm font-mono">Učitavanje tabele…</div>;
  }
  if (index.length === 0) {
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm">Nema test slučajeva za prikaz — proveri filter ili dodaj nove.</div>;
  }

  const cellCls = "border border-slate-200 px-3 py-2 text-xs text-slate-700 align-top whitespace-pre-wrap";

  return (
    <div className="p-4 overflow-x-auto">
      <table className="border-collapse bg-white text-left" style={{ minWidth: "1400px" }}>
        <thead className="sticky top-0 z-10">
          <tr>
            {COLS.map(([name, w]) => (
              <th key={name} className={`${w} border border-slate-300 bg-slate-100 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-600`}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {suites.map((s) => {
            const rows = index.filter((c) => c.suiteId === s.id);
            if (rows.length === 0) return null;
            return [
              <tr key={s.id}>
                <td colSpan={COLS.length} className="border border-slate-200 bg-indigo-50/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700">
                  {s.name}
                </td>
              </tr>,
              ...rows.map((row) => {
                const c = allCases[row.id];
                if (!c) return null;
                return (
                  <tr key={c.id} className="hover:bg-slate-50/70">
                    <td className={`${cellCls} font-mono`}>
                      <button onClick={() => onOpenCase(c.id)} className="text-indigo-600 hover:underline">{c.caseId}</button>
                    </td>
                    <td className={`${cellCls} font-medium text-slate-900`}>{c.title || "—"}</td>
                    <td className={cellCls}>{c.objective || "—"}</td>
                    <td className={cellCls}>{c.preconditions || "—"}</td>
                    <td className={cellCls}>
                      <ol className="space-y-1 list-none">
                        {c.steps.map((st, i) => (
                          <li key={st.id} className="flex items-start gap-1.5">
                            <span className="font-mono text-slate-400 shrink-0">{i + 1}.</span>
                            <span className="flex-1">{st.action || "—"}</span>
                            {st.image && (
                              <button
                                onMouseEnter={(e) => onShowPreview(e, st.image)}
                                onMouseMove={(e) => onShowPreview(e, st.image)}
                                onMouseLeave={onHidePreview}
                                onClick={() => { onHidePreview(); onLightbox(st.image); }}
                                className="text-indigo-500 hover:text-indigo-700 shrink-0" title="Screenshot — hover za pregled">
                                <ImageIcon size={13} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td className={cellCls}>{c.testData || "—"}</td>
                    <td className={cellCls}>
                      <ol className="space-y-1 list-none">
                        {c.steps.map((st, i) => (
                          <li key={st.id} className="flex items-start gap-1.5">
                            <span className="font-mono text-slate-400 shrink-0">{i + 1}.</span>
                            <span>{st.expected || "—"}</span>
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td className={cellCls}>{c.actualResult || "—"}</td>
                    <td className={`${cellCls}`}>
                      <select value={c.status} onChange={(e) => onStatusChange(c.id, e.target.value)}
                        className={`w-full text-xs rounded-md border px-1.5 py-1 outline-none cursor-pointer ${STATUSES[c.status]?.chip}`}>
                        {Object.entries(STATUSES).map(([k, cfg]) => (
                          <option key={k} value={k}>{cfg.label}</option>
                        ))}
                      </select>
                      {c.executedAt && (
                        <p className="mt-1 font-mono text-[10px] text-slate-400 leading-tight">
                          {c.executedBy}<br />{fmtTime(c.executedAt)}
                        </p>
                      )}
                    </td>
                    <td className={cellCls}>{c.postconditions || "—"}</td>
                    <td className={cellCls}>{(c.environment || []).join(", ") || "—"}</td>
                    <td className={cellCls}>{c.notes || "—"}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
