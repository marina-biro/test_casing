import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Plus, Trash2, ChevronUp, ChevronDown, Image as ImageIcon,
  FolderPlus, X, Clock, User, Save, Check, Printer
} from "lucide-react";
import { uploadScreenshot, deleteScreenshot } from "./storageShim.js";

// ---------- status config ----------
const STATUSES = {
  created:      { label: "Kreiran",       dot: "bg-sky-500", chip: "bg-sky-50 text-sky-700 border-sky-200" },
  not_executed: { label: "Nije izvršen", dot: "bg-slate-300", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  pass:         { label: "Pass",          dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  fail:         { label: "Fail",          dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  review:       { label: "Traži proveru", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  blocked:      { label: "Blocked",       dot: "bg-slate-700", chip: "bg-slate-800 text-slate-100 border-slate-700" },
};

const ENVIRONMENTS = ["Chrome", "Firefox", "Safari", "Edge", "iPhone", "Android", "Tablet", "API"];

const uid = () => crypto.randomUUID();
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
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX) { height = Math.round((height * MAX) / width); width = MAX; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
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

const emptyCase = (suiteId, seq, by, task) => {
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
    steps: [{ id: uid(), action: "", testData: "", expected: "", image: null }],
    actualResult: "",
    actualResultImage: null,
    task: task || null,
    status: "created",
    createdBy: by,
    createdAt: at,
    executedBy: by,
    executedAt: at,
    history: [{ status: "created", by, at, task: task || null }],
  };
};

export default function QATestCaseTool() {
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [task, setTask] = useState(""); // aktivan Jira task
  const [role, setRole] = useState("qa"); // "qa" | sve ostalo = samo citanje
  const canEdit = role === "qa";
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
  // filteri tabele zive ovde: prezivljavaju Editor<->Tabela i upisuju se u URL (deljivi linkovi)
  const [q, setQ] = useState("");
  const [taskQ, setTaskQ] = useState("");
  const [statusFilter, setStatusFilter] = useState(null); // null = bez filtera; Set = cekirano
  const [envFilter, setEnvFilter] = useState(null);
  const [allCases, setAllCases] = useState(null); // {id: fullCase} for table view
  const [tableLoading, setTableLoading] = useState(false);
  const [hoverPreview, setHoverPreview] = useState(null); // {src, x, y}
  const [sideQ, setSideQ] = useState("");
  const [sideW, setSideW] = useState(() => {
    const v = parseInt(localStorage.getItem("qa-tc:sideW") || "288", 10);
    return Number.isFinite(v) ? Math.min(560, Math.max(200, v)) : 288;
  });
  const sideWRef = useRef(sideW);
  const startResize = (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.min(560, Math.max(200, ev.clientX));
      sideWRef.current = w;
      setSideW(w);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try { localStorage.setItem("qa-tc:sideW", String(sideWRef.current)); } catch {}
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("qa-tc:collapsed") || "[]")); }
    catch { return new Set(); }
  });
  const toggleCollapse = (suiteId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(suiteId) ? next.delete(suiteId) : next.add(suiteId);
      try { localStorage.setItem("qa-tc:collapsed", JSON.stringify([...next])); } catch {}
      return next;
    });
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
    if (!canEdit) return;
    const full = allCases?.[id];
    if (!full) return;
    const by = userName.trim() || "nepoznat korisnik";
    const at = now();
    const updated = { ...full, status, executedBy: by, executedAt: at,
      history: [{ status, by, at, task: task.trim() || null }, ...(full.history || [])].slice(0, 20) };
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

  // ---------- URL <-> stanje: deljivi linkovi + browser Back ----------
  const applyUrlRef = useRef(() => {});
  applyUrlRef.current = () => {
    const p = new URLSearchParams(window.location.search);
    const st = p.get("status");
    setStatusFilter(st ? new Set(st.split(",").filter(Boolean)) : null);
    const en = p.get("env");
    setEnvFilter(en ? new Set(en.split(",").filter(Boolean)) : null);
    setTaskQ(p.get("task") || "");
    setQ(p.get("q") || "");
    if (p.get("view") === "table") {
      openTable();
    } else {
      setView("editor");
      const tcId = p.get("tc");
      if (tcId) openCase(tcId);
    }
  };
  useEffect(() => {
    const onPop = () => applyUrlRef.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const prevViewRef = useRef(view);
  useEffect(() => {
    if (loading) return;
    const p = new URLSearchParams();
    if (view === "table") p.set("view", "table");
    if (statusFilter !== null) p.set("status", [...statusFilter].join(","));
    if (envFilter !== null) p.set("env", [...envFilter].join(","));
    if (taskQ.trim()) p.set("task", taskQ.trim());
    if (q.trim()) p.set("q", q.trim());
    if (view === "editor" && selectedId) p.set("tc", selectedId);
    const qs = p.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (url === window.location.pathname + window.location.search) return;
    // promena prikaza ide u istoriju (radi Back), promene filtera samo azuriraju URL
    if (prevViewRef.current !== view) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    prevViewRef.current = view;
  }, [view, selectedId, q, taskQ, statusFilter, envFilter, loading]);

  // auto-reset delete confirmation after 3s
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const [u, meta, tk, rl] = await Promise.all([sGet("tc-user"), sGet("tc-meta"), sGet("tc-task"), sGet("tc-role")]);
      if (u) setUserName(u);
      if (tk) setTask(tk);
      const resolvedRole = rl || "viewer";
      setRole(resolvedRole);
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
      setTimeout(() => {
        const p = new URLSearchParams(window.location.search);
        if (resolvedRole !== "qa" && !p.get("view") && !p.get("tc")) {
          openTable(); // viewer bez linka slece na tabelu, ne na prazan editor
        } else {
          applyUrlRef.current();
        }
      }, 0);
    })();
  }, []);

  const persistMeta = useCallback((nextSuites, nextIndex) => {
    sSet("tc-meta", { suites: nextSuites, cases: nextIndex });
  }, []);

  // ---------- debounced save of open case ----------
  useEffect(() => {
    if (!tc || !canEdit) return;
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
    const fresh = emptyCase(suiteId, index.length + 1, userName.trim() || "nepoznat korisnik", task.trim() || null);
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

  const saveTask = () => {
    const norm = task.trim().toUpperCase().replace(/\s+/g, "-");
    setTask(norm);
    sSet("tc-task", norm);
  };

  const setStatus = (status) => {
    if (!canEdit) return;
    const by = userName.trim() || "nepoznat korisnik";
    const at = now();
    setTc((p) => ({
      ...p, status, executedBy: by, executedAt: at,
      history: [{ status, by, at, task: task.trim() || null }, ...(p.history || [])].slice(0, 20),
    }));
  };

  // steps
  const setStep = (stepId, field, value) =>
    setTc((p) => ({ ...p, steps: p.steps.map((s) => (s.id === stepId ? { ...s, [field]: value } : s)) }));
  const addStep = () => setTc((p) => ({ ...p, steps: [...p.steps, { id: uid(), action: "", testData: "", expected: "", image: null }] }));
  const removeStep = (stepId) => {
    const victim = tc?.steps.find((s) => s.id === stepId);
    if (victim?.image) deleteScreenshot(victim.image);
    setTc((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== stepId) }));
  };
  const moveStep = (i, dir) =>
    setTc((p) => {
      const steps = [...p.steps]; const j = i + dir;
      if (j < 0 || j >= steps.length) return p;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...p, steps };
    });

  const setStepFields = (stepId, fields) =>
    setTc((p) => ({ ...p, steps: p.steps.map((s) => (s.id === stepId ? { ...s, ...fields } : s)) }));

  const attachImage = async (stepId, file) => {
    const dataUrl = await resizeImage(file);
    const prev = tc?.steps.find((s) => s.id === stepId)?.image;
    try {
      const { path, url } = await uploadScreenshot(dataUrl);
      setStepFields(stepId, { image: path, imageUrl: url });
      if (prev) deleteScreenshot(prev); // stara slika (ako je bila) ide iz bucketa
    } catch (err) {
      // ako upload ne prodje, slika se cuva po starom (base64 u zapisu) da se ne izgubi
      console.error("Upload screenshota nije uspeo, cuvam base64:", err);
      setStepFields(stepId, { image: dataUrl, imageUrl: null });
    }
  };

  const attachActualImage = async (file) => {
    const dataUrl = await resizeImage(file);
    const prev = tc?.actualResultImage;
    try {
      const { path, url } = await uploadScreenshot(dataUrl);
      setTc((p) => ({ ...p, actualResultImage: path, actualResultImageUrl: url }));
      if (prev) deleteScreenshot(prev);
    } catch (err) {
      console.error("Upload screenshota nije uspeo, cuvam base64:", err);
      setTc((p) => ({ ...p, actualResultImage: dataUrl, actualResultImageUrl: null }));
    }
  };

  const handleActualPaste = async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    await attachActualImage(item.getAsFile());
  };

  const handlePaste = async (e, stepId) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    await attachImage(stepId, item.getAsFile());
  };

  const handleFile = async (e, stepId) => {
    const f = e.target.files?.[0];
    if (!f) return;
    await attachImage(stepId, f);
    e.target.value = "";
  };

  const toggleEnv = (env) =>
    setTc((p) => {
      const has = p.environment.includes(env);
      return { ...p, environment: has ? p.environment.filter((x) => x !== env) : [...p.environment, env] };
    });


  // ---------- render ----------
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-mono text-sm">
        Učitavanje test slučajeva…
      </div>
    );
  }

  const casesBySuite = (suiteId) => index.filter((c) => c.suiteId === suiteId);
  const stat = (key) => index.filter((c) => c.status === key).length;

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
        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-slate-500 ml-2">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />{stat("pass")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" />{stat("fail")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" />{stat("review")}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-700" />{stat("blocked")}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {canEdit ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              {saved ? <Check size={14} className="text-emerald-500" /> : <Save size={14} className="animate-pulse" />}
              <span>{saved ? "Sačuvano" : "Čuvam…"}</span>
            </div>
          ) : (
            <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2.5 py-1">samo pregled</span>
          )}
          {canEdit && (
          <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5"
            title="Aktivan Jira task — automatski se upisuje na nove TC-ove i promene statusa">
            <span className="text-xs font-mono text-slate-400">Task</span>
            <input value={task}
              onChange={(e) => setTask(e.target.value)}
              onBlur={saveTask}
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              placeholder="PA-1234"
              className="bg-transparent text-sm font-mono outline-none w-24 placeholder-slate-400 placeholder:italic" />
            {task && (
              <button onClick={() => { setTask(""); sSet("tc-task", ""); }}
                className="text-slate-300 hover:text-slate-500" title="Očisti task"><X size={13} /></button>
            )}
          </div>
          )}
          <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5" title="Ime je izvedeno iz email naloga">
            <User size={14} className="text-slate-400" />
            <span className="text-sm text-slate-700 font-mono">{userName || "…"}</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* sidebar */}
        {view === "editor" && (
        <aside className="shrink-0 border-r border-slate-200 bg-white overflow-y-auto" style={{ width: sideW }}>
          <div className="p-3">
            {canEdit && (!addingSuite ? (
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
            ))}
            <div className="relative mt-2">
              <input value={sideQ} onChange={(e) => setSideQ(e.target.value)}
                placeholder="Pretraga — ID, naziv, funkcionalnost…"
                className="w-full text-xs border border-slate-200 rounded-lg pl-3 pr-7 py-2 outline-none focus:border-indigo-400" />
              {sideQ && (
                <button onClick={() => setSideQ("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          {suites.length === 0 && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center leading-relaxed">
              Dodaj prvu funkcionalnost (suite) — npr. „Postavljanje oglasa" ili „Plaćanje" — pa u nju test slučajeve.
            </p>
          )}
          {suites.map((s) => {
            const needle = sideQ.trim().toLowerCase();
            const suiteMatch = needle && (s.name || "").toLowerCase().includes(needle);
            let vis = casesBySuite(s.id);
            if (needle && !suiteMatch) {
              vis = vis.filter((c) =>
                (c.caseId || "").toLowerCase().includes(needle) ||
                (c.title || "").toLowerCase().includes(needle));
              if (vis.length === 0) return null;
            }
            const isCol = collapsed.has(s.id) && !needle; // pretraga gleda i kroz skupljene
            return (
            <div key={s.id} className="mb-1">
              <div className="group flex items-center px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <button onClick={() => toggleCollapse(s.id)}
                  className="flex items-center gap-1 min-w-0 flex-1 text-left hover:text-slate-700"
                  title={isCol ? "Otvori" : "Skupi"}>
                  <ChevronDown size={13}
                    className={`shrink-0 transition-transform ${isCol ? "-rotate-90" : ""}`} />
                  <span className="truncate uppercase">{s.name}</span>
                  {isCol && (
                    <span className="ml-1 font-mono text-[10px] text-slate-400 normal-case">({vis.length})</span>
                  )}
                </button>
                {canEdit && (
                <button onClick={() => addCase(s.id)} title="Dodaj test slučaj"
                  className="ml-auto opacity-0 group-hover:opacity-100 text-indigo-600 hover:text-indigo-800 p-1"><Plus size={14} /></button>
                )}
                {canEdit && (
                <button onClick={() => deleteSuite(s.id)} title={confirmDelete === `suite-${s.id}` ? "Klikni ponovo za brisanje" : "Obriši suite"}
                  className={`p-1 ${confirmDelete === `suite-${s.id}` ? "opacity-100 text-rose-600" : "opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600"}`}>
                  {confirmDelete === `suite-${s.id}` ? <span className="text-[10px] font-bold normal-case">Sigurno?</span> : <Trash2 size={13} />}
                </button>
                )}
              </div>
              {!isCol && vis.map((c) => (
                <button key={c.id} onClick={() => openCase(c.id)}
                  title={`${c.caseId} — ${c.title || "Bez naziva"}`}
                  className={`w-full flex items-center gap-2 px-4 py-2 text-left text-sm border-l-2 transition-colors ${
                    selectedId === c.id ? "border-indigo-600 bg-indigo-50/60" : "border-transparent hover:bg-slate-50"}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUSES[c.status]?.dot || "bg-slate-300"}`} />
                  <span className="font-mono text-xs text-slate-400 shrink-0">{c.caseId}</span>
                  <span className="truncate text-slate-700">{c.title || "Bez naziva"}</span>
                </button>
              ))}
              {!isCol && vis.length === 0 && canEdit && (
                <button onClick={() => addCase(s.id)} className="w-full px-6 py-1.5 text-left text-xs text-indigo-500 hover:text-indigo-700">
                  + prvi test slučaj
                </button>
              )}
            </div>
            );
          })}
        </aside>
        )}
        {view === "editor" && (
          <div onMouseDown={startResize} title="Prevuci za širinu liste"
            className="w-1 shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-400 active:bg-indigo-500 transition-colors" />
        )}

        {/* main */}
        <main className="flex-1 overflow-y-auto">
          {view === "table" ? (
            <TableView
              suites={suites}
              index={index}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              canEdit={canEdit}
              q={q} setQ={setQ}
              taskQ={taskQ} setTaskQ={setTaskQ}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              envFilter={envFilter} setEnvFilter={setEnvFilter}
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
                  className="font-mono text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 w-32 focus:border-indigo-400 outline-none"
                  value={tc.caseId} onChange={(e) => setField("caseId", e.target.value)} placeholder="TC_001" readOnly={!canEdit} />
                <input
                  className="flex-1 text-lg font-semibold bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none placeholder-slate-400 placeholder:italic"
                  value={tc.title} onChange={(e) => setField("title", e.target.value)}
                  placeholder='Naziv — npr. „Login sa validnim kredencijalima"' readOnly={!canEdit} />
                {canEdit && (
                <button onClick={() => deleteCase(tc.id)} title={confirmDelete === `case-${tc.id}` ? "Klikni ponovo za brisanje" : "Obriši"}
                  className={`p-2.5 rounded-lg border ${confirmDelete === `case-${tc.id}` ? "bg-rose-50 border-rose-300 text-rose-600 text-xs font-semibold" : "text-slate-400 hover:text-rose-600 bg-white border-slate-200"}`}>
                  {confirmDelete === `case-${tc.id}` ? "Sigurno?" : <Trash2 size={16} />}
                </button>
                )}
              </div>

              {/* status bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(STATUSES).map(([key, cfg]) => (
                    <button key={key} onClick={() => setStatus(key)} disabled={!canEdit}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                        tc.status === key ? cfg.chip + " ring-2 ring-offset-1 ring-indigo-300" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"}`}>
                      {cfg.label}
                    </button>
                  ))}
                  {tc.executedAt && (
                    <span className="ml-auto flex items-center gap-1.5 text-xs font-mono text-slate-500">
                      <Clock size={13} />
                      {STATUSES[tc.status].label} · {tc.executedBy}{tc.history?.[0]?.task ? ` · ${tc.history[0].task}` : ""} · {fmtTime(tc.executedAt)}
                    </span>
                  )}
                </div>
              </div>

              {/* environment */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Test Environment</p>
                <div className="flex flex-wrap gap-2">
                  {ENVIRONMENTS.map((env) => (
                    <button key={env} onClick={() => canEdit && toggleEnv(env)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        tc.environment.includes(env) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300"}`}>
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              {/* preconditions */}
              <Field label="Preconditions" hint="šta mora da bude ispunjeno pre početka testa"
                value={tc.preconditions} onChange={(v) => setField("preconditions", v)} readOnly={!canEdit} />

              {/* steps */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Test Steps</p>
                  <p className="ml-auto text-xs text-slate-400">Screenshot: Ctrl+V direktno u polje koraka</p>
                </div>
                <div className="space-y-3">
                  {tc.steps.map((s, i) => (
                    <div key={s.id} className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
                      <div className="flex gap-3">
                        <div className="flex flex-col items-center gap-1 pt-1">
                          <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 rounded-md w-7 h-7 flex items-center justify-center">{i + 1}</span>
                          {canEdit && <button onClick={() => moveStep(i, -1)} className="text-slate-300 hover:text-slate-600"><ChevronUp size={14} /></button>}
                          {canEdit && <button onClick={() => moveStep(i, 1)} className="text-slate-300 hover:text-slate-600"><ChevronDown size={14} /></button>}
                        </div>
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
                          <textarea rows={2} readOnly={!canEdit} value={s.action}
                            onChange={(e) => setStep(s.id, "action", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id)}
                            placeholder="Akcija — npr. „Unesi email, klikni Login“"
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                          <textarea rows={2} readOnly={!canEdit} value={s.testData || ""}
                            onChange={(e) => setStep(s.id, "testData", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id)}
                            placeholder={"Test data — npr.\nuser@test.com / 123456"}
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                          <textarea rows={2} readOnly={!canEdit} value={s.expected}
                            onChange={(e) => setStep(s.id, "expected", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id)}
                            placeholder="Expected — npr. „Redirect na dashboard“"
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                        </div>
                        <div className="flex flex-col gap-1 items-end">
                          {canEdit && (
                          <label className="cursor-pointer text-slate-400 hover:text-indigo-600 p-1" title="Dodaj sliku">
                            <ImageIcon size={16} />
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e, s.id)} />
                          </label>
                          )}
                          {canEdit && (
                          <button onClick={() => removeStep(s.id)} className="text-slate-300 hover:text-rose-500 p-1" title="Obriši korak">
                            <X size={15} />
                          </button>
                          )}
                        </div>
                      </div>
                      {s.image && (
                        <div className="mt-2 ml-10 inline-flex items-center gap-1">
                          <button
                            onMouseEnter={(e) => showPreview(e, s.imageUrl || s.image)}
                            onMouseMove={(e) => showPreview(e, s.imageUrl || s.image)}
                            onMouseLeave={hidePreview}
                            onClick={() => { hidePreview(); setLightbox(s.imageUrl || s.image); }}
                            className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md px-2 py-1">
                            <ImageIcon size={13} /> screenshot
                          </button>
                          {canEdit && (
                          <button onClick={() => { deleteScreenshot(s.image); setStepFields(s.id, { image: null, imageUrl: null }); }}
                            className="text-slate-300 hover:text-rose-500 p-0.5" title="Ukloni sliku">
                            <X size={13} />
                          </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && (
                <button onClick={addStep}
                  className="mt-3 flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
                  <Plus size={15} /> Dodaj korak
                </button>
                )}
              </div>

              {/* actual / post / notes */}
              <Field label="Actual Result" hint="šta se stvarno desilo — screenshot ide sa Ctrl+V"
                value={tc.actualResult} onChange={(v) => setField("actualResult", v)}
                onPaste={canEdit ? handleActualPaste : undefined} readOnly={!canEdit}>
                {tc.actualResultImage && (
                  <div className="mt-2 inline-flex items-center gap-1">
                    <button
                      onMouseEnter={(e) => showPreview(e, tc.actualResultImageUrl || tc.actualResultImage)}
                      onMouseMove={(e) => showPreview(e, tc.actualResultImageUrl || tc.actualResultImage)}
                      onMouseLeave={hidePreview}
                      onClick={() => { hidePreview(); setLightbox(tc.actualResultImageUrl || tc.actualResultImage); }}
                      className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md px-2 py-1">
                      <ImageIcon size={13} /> screenshot
                    </button>
                    {canEdit && (
                    <button onClick={() => { deleteScreenshot(tc.actualResultImage); setTc((p) => ({ ...p, actualResultImage: null, actualResultImageUrl: null })); }}
                      className="text-slate-300 hover:text-rose-500 p-0.5" title="Ukloni sliku">
                      <X size={13} />
                    </button>
                    )}
                  </div>
                )}
              </Field>
              <Field label="Postconditions" hint="u kakvom je stanju sistem nakon završetka testa"
                value={tc.postconditions} onChange={(v) => setField("postconditions", v)} readOnly={!canEdit} />
              <Field label="Notes / Comments" hint="dodatne napomene, zapažanja, linkovi"
                value={tc.notes} onChange={(v) => setField("notes", v)} readOnly={!canEdit} />

              {/* istorija statusa - skroz na dnu, sklopiva */}
              {tc.history?.length > 0 && (
                <details className="bg-white border border-slate-200 rounded-xl p-4">
                  <summary className="text-xs font-semibold uppercase tracking-wider text-slate-500 cursor-pointer hover:text-slate-700">
                    Istorija statusa ({tc.history.length})
                  </summary>
                  <ul className="mt-3 space-y-1">
                    {tc.history.map((h, i) => (
                      <li key={i} className="text-xs font-mono text-slate-500 flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUSES[h.status]?.dot}`} />
                        {STATUSES[h.status]?.label} — {h.by}{h.task ? ` — ${h.task}` : ""} — {fmtTime(h.at)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
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
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function Field({ label, hint, value, onChange, placeholder, onPaste, children, readOnly }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {label}
        {hint && <span className="normal-case font-normal tracking-normal text-slate-400"> — {hint}</span>}
      </p>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onPaste={onPaste} readOnly={readOnly}
        className="w-full text-sm text-slate-800 bg-transparent outline-none resize-y placeholder-slate-400 placeholder:italic" />
      {children}
    </div>
  );
}

const COLUMNS = [
  { key: "caseId",        name: "Test Case ID",    w: "w-28" },
  { key: "title",         name: "Test Case",       w: "min-w-[180px]" },
  { key: "preconditions", name: "Preconditions",   w: "min-w-[150px]" },
  { key: "steps",         name: "Test Steps",      w: "min-w-[240px]" },
  { key: "testData",      name: "Test Data",       w: "min-w-[160px]" },
  { key: "expected",      name: "Expected Result", w: "min-w-[200px]" },
  { key: "actualResult",  name: "Actual Result",   w: "min-w-[150px]" },
  { key: "status",        name: "Status",          w: "w-40" },
  { key: "task",          name: "Task",            w: "w-28" },
  { key: "postconditions",name: "Postconditions",  w: "min-w-[140px]" },
  { key: "environment",   name: "Environment",     w: "min-w-[120px]" },
  { key: "notes",         name: "Notes",           w: "min-w-[140px]" },
];



function TableView({ suites, index, allCases, loading, onStatusChange, onOpenCase, onShowPreview, onHidePreview, onLightbox, collapsed, onToggleCollapse,
  canEdit, q, setQ, taskQ, setTaskQ, statusFilter, setStatusFilter, envFilter, setEnvFilter }) {
  const [printGroups, setPrintGroups] = useState(null);
  const toolbarRef = useRef(null);
  const [hiddenCols, setHiddenCols] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("qa-tc:hiddenCols") || "[]")); }
    catch { return new Set(); }
  });
  const [colsOpen, setColsOpen] = useState(false);
  const [openPanel, setOpenPanel] = useState(null); // null | "cols" | "status" | "env"

  // klik van trake zatvara otvoreni panel
  useEffect(() => {
    if (!openPanel) return;
    const onDown = (e) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target)) setOpenPanel(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openPanel]);

  const excelToggle = (prev, key, allKeys) => {
    let next;
    if (prev === null) {
      // "sve cekirano" -> odcekiranje jednog = svi osim njega
      next = new Set(allKeys);
      next.delete(key);
    } else {
      next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      if (next.size === allKeys.length) return null; // sve cekirano = bez filtera
    }
    return next;
  };

  const toggleCol = (key) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem("qa-tc:hiddenCols", JSON.stringify([...next])); } catch {}
      return next;
    });

  if (loading || !allCases) {
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm font-mono">Učitavanje tabele…</div>;
  }
  if (index.length === 0) {
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm">Nema test slučajeva za prikaz — proveri filter ili dodaj nove.</div>;
  }

  const cols = COLUMNS.filter((c) => !hiddenCols.has(c.key));

  // da li TC prolazi sve aktivne filtere; task se trazi kroz CELU istoriju
  const passes = (c) => {
    if (statusFilter !== null && !statusFilter.has(c.status)) return false;
    if (envFilter !== null && !(c.environment || []).some((e) => envFilter.has(e))) return false;
    const full = allCases[c.id] || {};
    if (taskQ.trim()) {
      const tn = taskQ.trim().toUpperCase();
      const hit = (full.task || "").toUpperCase().includes(tn) ||
        (full.history || []).some((h) => (h.task || "").toUpperCase().includes(tn));
      if (!hit) return false;
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      const suiteName = (suites.find((s) => s.id === c.suiteId)?.name || "").toLowerCase();
      const hit = (c.caseId || "").toLowerCase().includes(needle) ||
        (c.title || "").toLowerCase().includes(needle) ||
        suiteName.includes(needle) ||
        (full.task || "").toLowerCase().includes(needle) ||
        (full.history || []).some((h) => (h.task || "").toLowerCase().includes(needle));
      if (!hit) return false;
    }
    return true;
  };
  const anyFilterActive = statusFilter !== null || envFilter !== null || q.trim() || taskQ.trim();

  // ---------- izvoz u PDF (print-to-PDF) ----------
  const exportPdf = async () => {
    const groups = suites
      .map((s) => ({
        suite: s,
        cases: index.filter((c) => c.suiteId === s.id).filter(passes)
          .map((c) => allCases[c.id]).filter(Boolean),
      }))
      .filter((g) => g.cases.length > 0);
    if (groups.length === 0) return;

    // sacekaj da se slike ucitaju pre otvaranja print dijaloga
    const urls = [];
    groups.forEach((g) => g.cases.forEach((c) => {
      (c.steps || []).forEach((st) => {
        const u = st.imageUrl || (st.image?.startsWith("data:") ? st.image : null);
        if (u) urls.push(u);
      });
      const au = c.actualResultImageUrl || (c.actualResultImage?.startsWith("data:") ? c.actualResultImage : null);
      if (au) urls.push(au);
    }));
    await Promise.all(urls.map((u) => new Promise((res) => {
      const im = new Image();
      im.onload = im.onerror = res;
      im.src = u;
      setTimeout(res, 4000); // ne cekaj zauvek
    })));

    document.body.classList.add("tc-printing");
    setPrintGroups(groups);
    setTimeout(() => {
      window.print();
      document.body.classList.remove("tc-printing");
      setPrintGroups(null);
    }, 400);
  };
  const cellCls = "border-x border-slate-200 px-3 py-2 text-xs text-slate-800 align-top whitespace-pre-wrap";

  const STEP_COLS = new Set(["steps", "testData", "expected"]);

  // celije na nivou celog TC-a - protezu se rowSpan-om preko svih koraka
  const tcCell = (col, c, span, rowCls) => {
    const cls = `${cellCls} ${rowCls} align-top`;
    switch (col.key) {
      case "caseId":
        return <td key={col.key} rowSpan={span} className={`${cls} font-mono`}>
          <button onClick={() => onOpenCase(c.id)} className="text-indigo-600 hover:underline">{c.caseId}</button>
        </td>;
      case "title":
        return <td key={col.key} rowSpan={span} className={`${cls} font-medium text-slate-900`}>{c.title || "—"}</td>;
      case "preconditions":
        return <td key={col.key} rowSpan={span} className={cls}><Linkified text={c.preconditions} /></td>;
      case "actualResult":
        return <td key={col.key} rowSpan={span} className={cls}>
          <span className="flex items-start gap-1.5">
            <span className="flex-1"><Linkified text={c.actualResult} /></span>
            {c.actualResultImage && (
              <button
                onMouseEnter={(e) => onShowPreview(e, c.actualResultImageUrl || c.actualResultImage)}
                onMouseMove={(e) => onShowPreview(e, c.actualResultImageUrl || c.actualResultImage)}
                onMouseLeave={onHidePreview}
                onClick={() => { onHidePreview(); onLightbox(c.actualResultImageUrl || c.actualResultImage); }}
                className="text-indigo-500 hover:text-indigo-700 shrink-0" title="Screenshot — hover za pregled">
                <ImageIcon size={13} />
              </button>
            )}
          </span>
        </td>;
      case "status":
        return <td key={col.key} rowSpan={span} className={cls}>
          {canEdit ? (
          <select value={c.status} onChange={(e) => onStatusChange(c.id, e.target.value)}
            className={`w-full text-xs rounded-md border px-1.5 py-1 outline-none cursor-pointer ${STATUSES[c.status]?.chip}`}>
            {Object.entries(STATUSES).map(([k, cfg]) => (
              <option key={k} value={k}>{cfg.label}</option>
            ))}
          </select>
          ) : (
          <span className={`inline-block text-xs rounded-md border px-1.5 py-1 ${STATUSES[c.status]?.chip}`}>
            {STATUSES[c.status]?.label || c.status}
          </span>
          )}
          {c.executedAt && (
            <p className="mt-1 font-mono text-[10px] text-slate-500 leading-tight">
              {c.executedBy}{c.history?.[0]?.task ? ` · ${c.history[0].task}` : ""}<br />{fmtTime(c.executedAt)}
            </p>
          )}
        </td>;
      case "task": {
        const lastTask = c.history?.[0]?.task || c.task || null;
        return <td key={col.key} rowSpan={span} className={`${cls} font-mono`}>{lastTask || "—"}</td>;
      }
      case "postconditions":
        return <td key={col.key} rowSpan={span} className={cls}><Linkified text={c.postconditions} /></td>;
      case "environment":
        return <td key={col.key} rowSpan={span} className={cls}>{(c.environment || []).join(", ") || "—"}</td>;
      case "notes":
        return <td key={col.key} rowSpan={span} className={cls}><Linkified text={c.notes} /></td>;
      default:
        return null;
    }
  };

  // celije na nivou jednog koraka - jedan pod-red po koraku, savrseno poravnato
  const stepCell = (col, st, i, c, rowCls) => {
    const cls = `${cellCls} ${rowCls}`;
    switch (col.key) {
      case "steps":
        return <td key={col.key} className={cls}>
          <span className="flex items-start gap-1.5">
            <span className="font-mono text-slate-500 shrink-0">{i + 1}.</span>
            <span className="flex-1"><Linkified text={st.action} /></span>
            {st.image && (
              <button
                onMouseEnter={(e) => onShowPreview(e, st.imageUrl || st.image)}
                onMouseMove={(e) => onShowPreview(e, st.imageUrl || st.image)}
                onMouseLeave={onHidePreview}
                onClick={() => { onHidePreview(); onLightbox(st.imageUrl || st.image); }}
                className="text-indigo-500 hover:text-indigo-700 shrink-0" title="Screenshot — hover za pregled">
                <ImageIcon size={13} />
              </button>
            )}
          </span>
        </td>;
      case "testData":
        return <td key={col.key} className={cls}><Linkified text={st.testData || (i === 0 ? c.testData : "")} /></td>;
      case "expected":
        return <td key={col.key} className={cls}><Linkified text={st.expected} /></td>;
      default:
        return null;
    }
  };

  return (
    <div className="p-4">
      <div ref={toolbarRef} className="mb-3 flex items-center gap-2 flex-wrap">
        <FilterButton
          label="Status"
          active={statusFilter !== null}
          open={openPanel === "status"}
          onToggle={() => setOpenPanel(openPanel === "status" ? null : "status")}>
          {Object.entries(STATUSES).map(([k, cfg]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer py-1">
              <input type="checkbox" checked={statusFilter === null || statusFilter.has(k)}
                onChange={() => setStatusFilter((p) => excelToggle(p, k, Object.keys(STATUSES)))}
                className="accent-indigo-600" />
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </label>
          ))}
          <div className="flex gap-3 mt-2 pt-2 border-t border-slate-100">
            <button onClick={() => setStatusFilter(null)}
              className="text-[11px] text-indigo-600 hover:underline">Čekiraj sve</button>
            <button onClick={() => setStatusFilter(new Set())}
              className="text-[11px] text-indigo-600 hover:underline">Odčekiraj sve</button>
          </div>
        </FilterButton>

        <FilterButton
          label="Environment"
          active={envFilter !== null}
          open={openPanel === "env"}
          onToggle={() => setOpenPanel(openPanel === "env" ? null : "env")}>
          {ENVIRONMENTS.map((env) => (
            <label key={env} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer py-1">
              <input type="checkbox" checked={envFilter === null || envFilter.has(env)}
                onChange={() => setEnvFilter((p) => excelToggle(p, env, ENVIRONMENTS))}
                className="accent-indigo-600" />
              {env}
            </label>
          ))}
          <div className="flex gap-3 mt-2 pt-2 border-t border-slate-100">
            <button onClick={() => setEnvFilter(null)}
              className="text-[11px] text-indigo-600 hover:underline">Čekiraj sve</button>
            <button onClick={() => setEnvFilter(new Set())}
              className="text-[11px] text-indigo-600 hover:underline">Odčekiraj sve</button>
          </div>
        </FilterButton>

        {(statusFilter !== null || envFilter !== null || taskQ) && (
          <button onClick={() => { setStatusFilter(null); setEnvFilter(null); setTaskQ(""); }}
            className="text-xs text-indigo-600 hover:text-indigo-800 underline underline-offset-2">
            Poništi filtere
          </button>
        )}
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Pretraga — ID ili naziv…"
            className="text-xs border border-slate-200 rounded-lg pl-3 pr-7 py-1.5 w-56 outline-none focus:border-indigo-400 bg-white" />
          {q && (
            <button onClick={() => setQ("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
              <X size={13} />
            </button>
          )}
        </div>
        <button onClick={exportPdf}
          title="Izvoz onoga sto trenutno prolazi filtere"
          className="text-xs border border-slate-200 bg-white rounded-lg px-3 py-1.5 text-slate-600 hover:border-indigo-300 flex items-center gap-1.5">
          <Printer size={13} /> PDF
        </button>
        <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <input value={taskQ} onChange={(e) => setTaskQ(e.target.value)}
            placeholder="Task — npr. PA-1234"
            className={`text-xs border rounded-lg pl-3 pr-7 py-1.5 w-36 font-mono outline-none focus:border-indigo-400 ${
              taskQ ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-white"}`} />
          {taskQ && (
            <button onClick={() => setTaskQ("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
              <X size={13} />
            </button>
          )}
        </div>
        <FilterButton
          align="right"
          label={`Kolone (${cols.length}/${COLUMNS.length})`}
          active={hiddenCols.size > 0}
          open={openPanel === "cols"}
          onToggle={() => setOpenPanel(openPanel === "cols" ? null : "cols")}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {COLUMNS.map((col) => (
              <label key={col.key} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={!hiddenCols.has(col.key)} onChange={() => toggleCol(col.key)}
                  className="accent-indigo-600" />
                {col.name}
              </label>
            ))}
          </div>
        </FilterButton>
        </div>
      </div>
      {printGroups && createPortal(<PrintReport groups={printGroups} />, document.body)}
      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 160px)" }}>
        <table className="w-full border-collapse bg-white text-left" style={{ minWidth: cols.length > 6 ? "1200px" : "auto" }}>
          <thead className="sticky top-0 z-10">
            <tr>
              {cols.map((col) => (
                <th key={col.key}
                  className={`${col.w} border border-slate-300 bg-slate-100 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-700`}>
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {anyFilterActive && !index.some(passes) && (
              <tr>
                <td colSpan={cols.length} className="border border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                  Nijedan test slučaj ne prolazi filtere/pretragu — promeni izbor ili očisti pretragu.
                </td>
              </tr>
            )}
            {suites.map((s) => {
              const rows = index.filter((c) => c.suiteId === s.id).filter(passes);
              if (rows.length === 0) return null;
              const isCollapsed = collapsed.has(s.id) && !q.trim() && !taskQ.trim(); // pretraga/task gledaju i kroz skupljene
              return [
                <tr key={s.id}>
                  <td colSpan={cols.length}
                    onClick={() => onToggleCollapse(s.id)}
                    className="border-x border-slate-200 border-t-2 border-t-slate-300 bg-indigo-50/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700 cursor-pointer select-none hover:bg-indigo-100/70"
                    title={isCollapsed ? "Otvori" : "Skupi"}>
                    <span className="inline-flex items-center gap-1.5">
                      <ChevronDown size={13} className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                      {s.name}
                      <span className="font-mono text-[10px] text-indigo-400 normal-case">({rows.length})</span>
                    </span>
                  </td>
                </tr>,
                ...(isCollapsed ? [] : [
                rows.flatMap((row, tcIdx) => {
                  const c = allCases[row.id];
                  if (!c) return [];
                  const steps = c.steps && c.steps.length > 0
                    ? c.steps
                    : [{ id: "none", action: "", testData: "", expected: "", image: null }];
                  const zebra = tcIdx % 2 === 1 ? "bg-slate-50" : "bg-white";
                  return steps.map((st, i) => {
                    // deblja linija na pocetku TC-a, tanja svetlija izmedju koraka
                    const topCls = i === 0 ? "border-t-2 border-t-slate-300" : "border-t border-t-slate-200/60";
                    const rowCls = `${zebra} ${topCls}`;
                    return (
                      <tr key={`${c.id}-${st.id}`}>
                        {cols.map((col) =>
                          STEP_COLS.has(col.key)
                            ? stepCell(col, st, i, c, rowCls)
                            : i === 0
                              ? tcCell(col, c, steps.length, rowCls)
                              : null)}
                      </tr>
                    );
                  });
                })]),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterButton({ label, active, open, onToggle, children, align = "left" }) {
  return (
    <div className="relative">
      <button onClick={onToggle}
        className={`text-xs border rounded-lg px-3 py-1.5 ${
          active ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium"
                 : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"}`}>
        {label} {active ? "▾●" : "▾"}
      </button>
      {open && (
        <div className={`absolute top-9 ${align === "right" ? "right-0" : "left-0"} z-30 bg-white border border-slate-200 rounded-xl shadow-lg p-3 min-w-[180px] w-max max-w-[320px]`}>
          {children}
        </div>
      )}
    </div>
  );
}

function PrintReport({ groups }) {
  const today = fmtTime(new Date().toISOString());
  const allCasesFlat = groups.flatMap((g) => g.cases.map((c) => ({ ...c, _suite: g.suite.name })));
  const imgSrc = (path, url) => url || (path && path.startsWith("data:") ? path : null);

  return (
    <div className="tc-print-report">
      <style>{`
        .tc-print-report { display: none; }
        @media print {
          body.tc-printing #root { display: none !important; }
          body.tc-printing .tc-print-report { display: block !important; }
          .tc-print-report { font-family: system-ui, sans-serif; color: #1e293b; font-size: 11px; }
          .tc-print-report h1 { font-size: 18px; margin: 0 0 2px; }
          .tc-print-report .sub { color: #64748b; font-size: 10px; margin-bottom: 14px; }
          .tc-print-report h2 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #4338ca; }
          .tc-print-report table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
          .tc-print-report th, .tc-print-report td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; vertical-align: top; }
          .tc-print-report th { background: #f1f5f9; font-size: 10px; text-transform: uppercase; }
          .tc-print-report .summary { page-break-after: always; }
          .tc-print-report .tc-block { break-inside: avoid; page-break-inside: avoid; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; margin-bottom: 12px; }
          .tc-print-report .tc-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
          .tc-print-report .tc-id { font-family: monospace; color: #4338ca; font-weight: bold; }
          .tc-print-report .tc-title { font-size: 13px; font-weight: 600; }
          .tc-print-report .badge { font-size: 10px; border: 1px solid #94a3b8; border-radius: 999px; padding: 1px 8px; }
          .tc-print-report .meta { color: #475569; margin: 2px 0; }
          .tc-print-report img.thumb { max-height: 110px; max-width: 100%; border: 1px solid #cbd5e1; border-radius: 4px; display: block; margin-top: 3px; }
          .tc-print-report .hist { color: #64748b; font-family: monospace; font-size: 10px; margin: 1px 0; }
        }
      `}</style>

      <h1>Test Case Report</h1>
      <p className="sub">Generisano: {today}</p>

      <div className="summary">
        <h2>Pregled scenarija</h2>
        <table>
          <thead>
            <tr><th>Funkcionalnost</th><th>ID</th><th>Naziv</th><th>Status</th><th>Poslednja promena</th></tr>
          </thead>
          <tbody>
            {allCasesFlat.map((c) => (
              <tr key={c.id}>
                <td>{c._suite}</td>
                <td style={{ fontFamily: "monospace" }}>{c.caseId}</td>
                <td>{c.title || "—"}</td>
                <td>{STATUSES[c.status]?.label || c.status}</td>
                <td style={{ fontFamily: "monospace", fontSize: "10px" }}>
                  {c.executedBy || "—"}{c.history?.[0]?.task ? ` · ${c.history[0].task}` : ""}{c.executedAt ? ` · ${fmtTime(c.executedAt)}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groups.map((g) => (
        <div key={g.suite.id}>
          <h2>{g.suite.name}</h2>
          {g.cases.map((c) => (
            <div key={c.id} className="tc-block">
              <div className="tc-head">
                <span><span className="tc-id">{c.caseId}</span>{"  "}<span className="tc-title">{c.title || "Bez naziva"}</span></span>
                <span className="badge">{STATUSES[c.status]?.label || c.status}</span>
              </div>
              {c.history?.[0]?.task && <p className="meta"><b>Task:</b> {c.history[0].task}</p>}
              {(c.environment || []).length > 0 && <p className="meta"><b>Environment:</b> {c.environment.join(", ")}</p>}
              {c.preconditions && <p className="meta"><b>Preconditions:</b> {c.preconditions}</p>}

              {(c.steps || []).some((st) => st.action || st.expected || st.testData || st.image) && (
                <table>
                  <thead>
                    <tr><th style={{ width: "18px" }}>#</th><th>Akcija</th><th>Test data</th><th>Expected</th></tr>
                  </thead>
                  <tbody>
                    {c.steps.map((st, i) => (
                      <tr key={st.id}>
                        <td style={{ fontFamily: "monospace" }}>{i + 1}</td>
                        <td>
                          {st.action || "—"}
                          {imgSrc(st.image, st.imageUrl) && <img className="thumb" src={imgSrc(st.image, st.imageUrl)} alt="" />}
                        </td>
                        <td>{st.testData || "—"}</td>
                        <td>{st.expected || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {(c.actualResult || c.actualResultImage) && (
                <p className="meta"><b>Actual Result:</b> {c.actualResult || ""}
                  {imgSrc(c.actualResultImage, c.actualResultImageUrl) && <img className="thumb" src={imgSrc(c.actualResultImage, c.actualResultImageUrl)} alt="" />}
                </p>
              )}
              {c.postconditions && <p className="meta"><b>Postconditions:</b> {c.postconditions}</p>}
              {c.notes && <p className="meta"><b>Notes:</b> {c.notes}</p>}
              {(c.history || []).length > 0 && (
                <div style={{ marginTop: "4px" }}>
                  {c.history.map((h, i) => (
                    <p key={i} className="hist">{STATUSES[h.status]?.label || h.status} — {h.by}{h.task ? ` — ${h.task}` : ""} — {fmtTime(h.at)}</p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Lightbox({ src, onClose }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const boxRef = useRef(null);
  const dragRef = useRef(null);

  const clamp = (s) => Math.min(6, Math.max(1, s));
  const zoomTo = (next) => {
    const s = clamp(next);
    setScale(s);
    if (s === 1) setPos({ x: 0, y: 0 });
  };

  // wheel mora ne-pasivno da bi preventDefault radio
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      zoomTo(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onMouseDown = (e) => {
    if (scale <= 1) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    const move = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      d.moved = true;
      setPos({ x: d.ox + (ev.clientX - d.sx), y: d.oy + (ev.clientY - d.sy) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setTimeout(() => { dragRef.current = null; }, 0);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={boxRef}
      className="fixed inset-0 bg-slate-900/85 z-50 flex items-center justify-center overflow-hidden"
      onClick={() => { if (!dragRef.current?.moved) onClose(); }}>
      <img src={src} alt="Screenshot"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onMouseDown}
        onDoubleClick={(e) => { e.stopPropagation(); zoomTo(scale > 1 ? 1 : 2.5); }}
        draggable={false}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
                 cursor: scale > 1 ? "grab" : "zoom-in",
                 transition: dragRef.current ? "none" : "transform 120ms" }}
        className="max-w-[92vw] max-h-[92vh] rounded-xl shadow-2xl select-none" />
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-800/90 rounded-full px-2 py-1.5"
        onClick={(e) => e.stopPropagation()}>
        <button onClick={() => zoomTo(scale / 1.4)} className="text-slate-200 hover:text-white w-7 h-7 text-lg leading-none">−</button>
        <span className="text-slate-300 text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomTo(scale * 1.4)} className="text-slate-200 hover:text-white w-7 h-7 text-lg leading-none">+</button>
        <button onClick={() => zoomTo(1)} className="text-slate-300 hover:text-white text-xs px-2">Reset</button>
        <button onClick={onClose} className="text-slate-300 hover:text-white px-2"><X size={15} /></button>
      </div>
      <p className="absolute top-4 left-1/2 -translate-x-1/2 text-slate-400 text-xs">
        scroll = zoom · prevlačenje = pomeranje · dupli klik = 250% · Esc = zatvori
      </p>
    </div>
  );
}

// tekst sa kliktabilnim URL-ovima (za tabelu)
function Linkified({ text }) {
  if (!text) return "—";
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-indigo-600 underline underline-offset-2 break-all hover:text-indigo-800">{p}</a>
      : p
  );
}
