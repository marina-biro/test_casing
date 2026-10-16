import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, Trash2, ChevronUp, ChevronDown, Image as ImageIcon,
  FolderPlus, X, Clock, User, Save, Check, Printer, Pencil, Upload
} from "lucide-react";
import { uploadScreenshot, deleteScreenshot } from "./storageShim.js";
import ImportModal from "./ImportModal.jsx";
import Field from "./components/Field.jsx";
import Lightbox from "./components/Lightbox.jsx";
import TableView from "./components/TableView.jsx";
import { Linkified, TaskLink } from "./components/Linkified.jsx";
import { STATUSES, PRIORITIES, CASE_TYPES, ENVIRONMENTS, uid, now, fmtTime, resizeImage, smartLink } from "./lib.js";

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
    businessDocumentation: "",
    businessDocumentationImages: [], // [{path, url?}] - max 3
    preconditions: "",
    testData: "",
    postconditions: "",
    environment: [],
    notes: "",
    steps: [{ id: uid(), action: "", testData: "", expected: "", mark: null, image: null }],
    actualResult: "",
    actualResultImages: [], // [{path, url?}] - url je izveden, ne cuva se
    task: task || null,
    priority: "medium",
    caseType: "positive",
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
  const [importOpen, setImportOpen] = useState(false);
  const [renamingSuite, setRenamingSuite] = useState(null); // {id, name}
  const [dragOverSuite, setDragOverSuite] = useState(null);
  const [dragOverCase, setDragOverCase] = useState(null);

  const renameSuite = (id, name) => {
    const clean = (name || "").trim();
    setRenamingSuite(null);
    if (!clean) return;
    const nextS = suites.map((s) => (s.id === id ? { ...s, name: clean } : s));
    setSuites(nextS);
    persistMeta(nextS, index);
  };

  // premesti TC: u suite (na kraj) ili ispred konkretnog TC-a (beforeId)
  const moveCase = async (caseId, suiteId, beforeId = null) => {
    setDragOverSuite(null);
    setDragOverCase(null);
    const drag = index.find((c) => c.id === caseId);
    if (!drag || caseId === beforeId) return;

    // ciljna lista bez prevucenog, pa umetni na pravo mesto
    const target = index
      .filter((c) => c.suiteId === suiteId && c.id !== caseId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const at = beforeId ? target.findIndex((c) => c.id === beforeId) : target.length;
    target.splice(at < 0 ? target.length : at, 0, { ...drag, suiteId });

    // pozicije 1..n samo u ciljnom suite-u; prevuceni menja i suiteId
    const posMap = new Map(target.map((c, i) => [c.id, i + 1]));
    const nextI = index.map((c) =>
      posMap.has(c.id)
        ? { ...c, suiteId: c.id === caseId ? suiteId : c.suiteId, position: posMap.get(c.id) }
        : c
    );
    setIndex(nextI);
    persistMeta(suites, nextI);
    if (tc?.id === caseId) setTc((p) => ({ ...p, suiteId }));
    setAllCases((p) => (p && p[caseId] ? { ...p, [caseId]: { ...p[caseId], suiteId } } : p));
    try {
      await sSet("tc-positions", target.map((c, i) => ({ id: c.id, suiteId, position: i + 1 })));
    } catch (err) {
      console.error("Premestanje nije uspelo:", err);
    }
  };
  const [newSuiteName, setNewSuiteName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [view, setView] = useState("editor"); // "editor" | "table"
  // filteri tabele zive ovde: prezivljavaju Editor<->Tabela i upisuju se u URL (deljivi linkovi)
  const [q, setQ] = useState("");
  const [taskQ, setTaskQ] = useState("");
  const [statusFilter, setStatusFilter] = useState(null); // null = bez filtera; Set = cekirano
  const [envFilter, setEnvFilter] = useState(null);
  const [priorityFilter, setPriorityFilter] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [allCases, setAllCases] = useState(null); // {id: fullCase} for table view
  const allCasesRef = useRef(null);
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
  // items parametar sprečava stale closure tokom inicijalnog učitavanja:
  // prvi render još uvek ima prazan index, iako je meta upravo učitan.
  const cacheFreshRef = useRef(false); // da li allCases odgovara trenutnom indeksu

  const prefetchAllCases = async () => {
    setTableLoading(true);
    try {
      const map = await sGet("tc-cases-all"); // svi TC-ovi u par upita
      if (map) { setAllCases(map); cacheFreshRef.current = true; }
    } finally {
      setTableLoading(false);
    }
  };

  const openTable = async (items = index) => {
    const list = Array.isArray(items) ? items : index;
    setView("table");
    const cached = allCasesRef.current;
    const hit = cacheFreshRef.current && cached && list.every((c) => cached[c.id]);
    if (hit) { setTableLoading(false); return; } // kes svez -> trenutno
    await prefetchAllCases(); // inace jedan batch, ne N poziva
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
  const urlAppliedRef = useRef(false); // dok je false, write-efekat ne dira URL
  useEffect(() => { allCasesRef.current = allCases; }, [allCases]);
  const applyUrlRef = useRef(() => {});
  applyUrlRef.current = (savedParams, loadedCases) => {
    const p = savedParams || new URLSearchParams(window.location.search);
    const st = p.get("status");
    setStatusFilter(st ? new Set(st.split(",").filter(Boolean)) : null);
    const en = p.get("env");
    setEnvFilter(en ? new Set(en.split(",").filter(Boolean)) : null);
    const pr = p.get("priority");
    setPriorityFilter(pr ? new Set(pr.split(",").filter(Boolean)) : null);
    const ty = p.get("type");
    setTypeFilter(ty ? new Set(ty.split(",").filter(Boolean)) : null);
    setTaskQ(p.get("task") || "");
    setQ(p.get("q") || "");
    if (p.get("view") === "table") {
      openTable(loadedCases); // na prvom loadu koristi upravo ucitan index
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
    if (loading || !urlAppliedRef.current) return; // ne gazi deljene linkove pre citanja
    const p = new URLSearchParams();
    if (view === "table") p.set("view", "table");
    if (statusFilter !== null) p.set("status", [...statusFilter].join(","));
    if (envFilter !== null) p.set("env", [...envFilter].join(","));
    if (priorityFilter !== null) p.set("priority", [...priorityFilter].join(","));
    if (typeFilter !== null) p.set("type", [...typeFilter].join(","));
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
  }, [view, selectedId, q, taskQ, statusFilter, envFilter, priorityFilter, typeFilter, loading]);

  // auto-reset delete confirmation after 3s
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const T = (label, t0) => console.log(`[perf] ${label}: ${Math.round(performance.now() - t0)}ms`);
      const boot0 = performance.now();
      const tMeta = performance.now();
      const [u, meta, tk, rl] = await Promise.all([sGet("tc-user"), sGet("tc-meta"), sGet("tc-task"), sGet("tc-role")]);
      T("meta+user+task+role (paralelno)", tMeta);
      if (u) setUserName(u);
      if (tk) setTask(tk);
      const resolvedRole = rl || "viewer";
      setRole(resolvedRole);
      let loadedCases = [];
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
        loadedCases = cases;
        setSuites(meta.suites || []);
        setIndex(cases);
      }
      // parametri se citaju ODMAH (sinhrono) - pre nego sto write-efekat
      // stigne da ih pregazi podrazumevanim stanjem
      const p = new URLSearchParams(window.location.search);
      setLoading(false);
      urlAppliedRef.current = true;
      // odredi pocetni prikaz odmah, bez cekanja punih TC-ova
      if (p.get("view") === "table" || (!p.get("view") && !p.get("tc"))) {
        setView("table");
        if (p.get("status")) setStatusFilter(new Set(p.get("status").split(",").filter(Boolean)));
        if (p.get("env")) setEnvFilter(new Set(p.get("env").split(",").filter(Boolean)));
        if (p.get("priority")) setPriorityFilter(new Set(p.get("priority").split(",").filter(Boolean)));
        if (p.get("type")) setTypeFilter(new Set(p.get("type").split(",").filter(Boolean)));
        if (p.get("task")) setTaskQ(p.get("task"));
        if (p.get("q")) setQ(p.get("q"));
        // puni sadrzaj u pozadini: tabela je vec vidljiva iz meta podataka
        const tPf = performance.now();
        prefetchAllCases().then(() => { T("prefetch svih TC-ova", tPf); T("UKUPNO do punog", boot0); });
      } else {
        setView("editor");
        const tcId = p.get("tc");
        if (tcId) openCase(tcId);
      }
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
      setAllCases((p) => (p ? { ...p, [tc.id]: tc } : p)); // kes ostaje svez
      setIndex((prev) => {
        const next = prev.map((c) =>
          c.id === tc.id ? { ...c, title: tc.title, caseId: tc.caseId, status: tc.status, suiteId: tc.suiteId, environment: tc.environment, priority: tc.priority, caseType: tc.caseType } : c
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
    setAllCases((p) => { if (!p) return p; const n = { ...p }; doomed.forEach((c) => delete n[c.id]); return n; });
    const nextS = suites.filter((s) => s.id !== id);
    const nextI = index.filter((c) => c.suiteId !== id);
    setSuites(nextS); setIndex(nextI); persistMeta(nextS, nextI);
    if (tc && tc.suiteId === id) { setTc(null); setSelectedId(null); }
  };

  const nextSeqFallback = () => {
    // najveci broj iz postojecih ID-jeva + 1 (radi i ako rpc nije dostupan)
    const nums = index.map((c) => parseInt(String(c.caseId || "").replace(/\D/g, ""), 10)).filter(Number.isFinite);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  };

  const addCase = async (suiteId) => {
    let seq;
    try {
      seq = await sGet("tc-next-seq"); // atomski brojac u bazi - nikad ne ponavlja broj
      if (!Number.isFinite(Number(seq))) throw new Error("bad seq");
      seq = Number(seq);
    } catch {
      seq = nextSeqFallback();
    }
    const fresh = emptyCase(suiteId, seq, userName.trim() || "nepoznat korisnik", task.trim() || null);
    fresh.position = Math.max(0, ...index.filter((c) => c.suiteId === suiteId).map((c) => c.position ?? 0)) + 1;
    await sSet(`tc-case-${fresh.id}`, fresh);
    setAllCases((p) => (p ? { ...p, [fresh.id]: fresh } : p));
    const nextI = [...index, { id: fresh.id, suiteId, caseId: fresh.caseId, title: "", status: "created", environment: [], priority: fresh.priority, caseType: fresh.caseType, position: fresh.position }];
    setIndex(nextI); persistMeta(suites, nextI);
    setSelectedId(fresh.id); setTc(fresh);
  };

  // uvezeni slucajevi su vec u bazi - ovde se samo osvezava state
  const handleImported = ({ suites: nextSuites, cases: newCases }) => {
    setSuites(nextSuites);
    setAllCases((p) =>
      p ? { ...p, ...Object.fromEntries(newCases.map((c) => [c.id, c])) } : p
    );
    const nextI = [
      ...index,
      ...newCases.map((c) => ({
        id: c.id,
        suiteId: c.suiteId,
        caseId: c.caseId,
        title: c.title,
        status: c.status,
        environment: c.environment,
        priority: c.priority,
        caseType: c.caseType,
        position: c.position,
      })),
    ];
    setIndex(nextI);
    persistMeta(nextSuites, nextI);
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
    setAllCases((p) => { if (!p) return p; const n = { ...p }; delete n[id]; return n; });
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
  const addStep = () => setTc((p) => ({ ...p, steps: [...p.steps, { id: uid(), action: "", testData: "", expected: "", mark: null, image: null }] }));
  const removeStep = (stepId) => {
    if (confirmDelete !== `step-${stepId}`) { setConfirmDelete(`step-${stepId}`); return; }
    setConfirmDelete(null);
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
    try {
      const { path, url } = await uploadScreenshot(dataUrl);
      setTc((p) => ({ ...p, actualResultImages: [...(p.actualResultImages || []), { path, url }] }));
    } catch (err) {
      console.error("Upload screenshota nije uspeo, cuvam base64:", err);
      setTc((p) => ({ ...p, actualResultImages: [...(p.actualResultImages || []), { path: dataUrl, url: null }] }));
    }
  };

  const removeActualImage = (path) => {
    deleteScreenshot(path);
    setTc((p) => ({ ...p, actualResultImages: (p.actualResultImages || []).filter((im) => im.path !== path) }));
  };

  const handleActualPaste = async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    await attachActualImage(item.getAsFile());
  };

  const MAX_BIZ_DOC_IMAGES = 3;

  const attachBizDocImage = async (file) => {
    if (!file || (tc?.businessDocumentationImages || []).length >= MAX_BIZ_DOC_IMAGES) return;
    const dataUrl = await resizeImage(file);
    try {
      const { path, url } = await uploadScreenshot(dataUrl);
      setTc((p) => ({ ...p, businessDocumentationImages: [...(p.businessDocumentationImages || []), { path, url }] }));
    } catch (err) {
      console.error("Upload screenshota nije uspeo, cuvam base64:", err);
      setTc((p) => ({ ...p, businessDocumentationImages: [...(p.businessDocumentationImages || []), { path: dataUrl, url: null }] }));
    }
  };

  const removeBizDocImage = (path) => {
    deleteScreenshot(path);
    setTc((p) => ({ ...p, businessDocumentationImages: (p.businessDocumentationImages || []).filter((im) => im.path !== path) }));
  };

  const handleBizDocPaste = async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    await attachBizDocImage(item.getAsFile());
  };

  const handleBizDocFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await attachBizDocImage(file);
  };

  const handlePaste = async (e, stepId, field) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (item) {
      e.preventDefault();
      await attachImage(stepId, item.getAsFile());
      return;
    }
    // selektovan tekst + nalepljen URL -> [tekst](url)
    if (field) {
      const next = smartLink(e);
      if (next !== null) {
        e.preventDefault();
        setStepFields(stepId, { [field]: next });
      }
    }
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
        Loading test cases…
      </div>
    );
  }

  const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0);
  const casesBySuite = (suiteId) => index.filter((c) => c.suiteId === suiteId).sort(byPos);
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
          <button onClick={() => openTable()}
            className={`px-3 py-1.5 rounded-md transition-colors ${view === "table" ? "bg-white shadow-sm text-indigo-700" : "text-slate-500 hover:text-slate-700"}`}>
            Table
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
              <span>{saved ? "Saved" : "Saving…"}</span>
            </div>
          ) : (
            <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2.5 py-1">view only</span>
          )}
          {canEdit && (
          <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5"
            title="Active Jira task — automatically attached to new TCs and status changes">
            <span className="text-xs font-mono text-slate-400">Task</span>
            <input value={task}
              onChange={(e) => setTask(e.target.value)}
              onBlur={saveTask}
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              placeholder="PA-1234"
              className="bg-transparent text-sm font-mono outline-none w-24 placeholder-slate-400 placeholder:italic" />
            {task && (
              <button onClick={() => { setTask(""); sSet("tc-task", ""); }}
                className="text-slate-300 hover:text-slate-500" title="Clear task"><X size={13} /></button>
            )}
          </div>
          )}
          <div className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-1.5" title="Name is derived from your email account">
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
                <FolderPlus size={15} /> New suite
              </button>
            ) : (
              <div className="flex gap-1.5">
                <input autoFocus value={newSuiteName}
                  onChange={(e) => setNewSuiteName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addSuite(); if (e.key === "Escape") { setAddingSuite(false); setNewSuiteName(""); } }}
                  placeholder="Name — e.g. Payments"
                  className="flex-1 min-w-0 text-sm border border-indigo-300 rounded-lg px-2.5 py-2 outline-none focus:border-indigo-500" />
                <button onClick={addSuite} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-2.5" title="Add"><Check size={15} /></button>
                <button onClick={() => { setAddingSuite(false); setNewSuiteName(""); }} className="text-slate-400 hover:text-slate-600 px-1" title="Cancel"><X size={15} /></button>
              </div>
            ))}
            {canEdit && (
              <button onClick={() => setImportOpen(true)}
                className="w-full mt-2 flex items-center justify-center gap-2 text-xs font-medium text-slate-600 hover:text-indigo-700 border border-slate-200 hover:border-indigo-300 rounded-lg py-1.5 transition-colors">
                <Upload size={13} /> Import CSV
              </button>
            )}
            <div className="relative mt-2">
              <input value={sideQ} onChange={(e) => setSideQ(e.target.value)}
                placeholder="Search — ID, title, suite…"
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
              Add your first suite — e.g. "Ad posting" or "Payments" — then add test cases to it.
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
              <div
                onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverSuite(s.id); } : undefined}
                onDragLeave={canEdit ? () => setDragOverSuite((p) => (p === s.id ? null : p)) : undefined}
                onDrop={canEdit ? (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/tc-id"); if (id) moveCase(id, s.id); } : undefined}
                className={`group flex items-center px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500 rounded-md transition-colors ${
                  dragOverSuite === s.id ? "bg-indigo-100 ring-1 ring-indigo-300" : ""}`}>
                {renamingSuite?.id === s.id ? (
                  <input autoFocus value={renamingSuite.name}
                    onChange={(e) => setRenamingSuite({ id: s.id, name: e.target.value })}
                    onBlur={() => renameSuite(s.id, renamingSuite.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameSuite(s.id, renamingSuite.name);
                      if (e.key === "Escape") setRenamingSuite(null);
                    }}
                    className="flex-1 min-w-0 text-xs font-semibold uppercase bg-white border border-indigo-300 rounded px-2 py-1 outline-none" />
                ) : (
                <button onClick={() => toggleCollapse(s.id)}
                  className="flex items-center gap-1 min-w-0 flex-1 text-left hover:text-slate-700"
                  title={isCol ? "Expand" : "Collapse"}>
                  <ChevronDown size={13}
                    className={`shrink-0 transition-transform ${isCol ? "-rotate-90" : ""}`} />
                  <span className="truncate uppercase">{s.name}</span>
                  {isCol && (
                    <span className="ml-1 font-mono text-[10px] text-slate-400 normal-case">({vis.length})</span>
                  )}
                </button>
                )}
                {canEdit && renamingSuite?.id !== s.id && (
                <button onClick={() => setRenamingSuite({ id: s.id, name: s.name })} title="Rename suite"
                  className="ml-auto opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-600 p-1"><Pencil size={12} /></button>
                )}
                {canEdit && (
                <button onClick={() => addCase(s.id)} title="Add test case"
                  className="opacity-0 group-hover:opacity-100 text-indigo-600 hover:text-indigo-800 p-1"><Plus size={14} /></button>
                )}
                {canEdit && (
                <button onClick={() => deleteSuite(s.id)} title={confirmDelete === `suite-${s.id}` ? "Click again to delete" : "Delete suite"}
                  className={`p-1 ${confirmDelete === `suite-${s.id}` ? "opacity-100 text-rose-600" : "opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600"}`}>
                  {confirmDelete === `suite-${s.id}` ? <span className="text-[10px] font-bold normal-case">Sure?</span> : <Trash2 size={13} />}
                </button>
                )}
              </div>
              {!isCol && vis.map((c) => (
                <button key={c.id} onClick={() => openCase(c.id)}
                  title={`${c.caseId} — ${c.title || "Untitled"}`}
                  draggable={canEdit}
                  onDragStart={(e) => { e.dataTransfer.setData("text/tc-id", c.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); setDragOverCase(c.id); } : undefined}
                  onDragLeave={canEdit ? () => setDragOverCase((p) => (p === c.id ? null : p)) : undefined}
                  onDrop={canEdit ? (e) => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData("text/tc-id"); if (id) moveCase(id, c.suiteId, c.id); } : undefined}
                  className={`w-full flex items-center gap-2 px-4 py-2 text-left text-sm border-l-2 transition-colors ${
                    dragOverCase === c.id ? "shadow-[inset_0_2px_0_0_#6366f1] " : ""}${canEdit ? "cursor-grab active:cursor-grabbing " : ""}${
                    selectedId === c.id ? "border-indigo-600 bg-indigo-50/60" : "border-transparent hover:bg-slate-50"}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUSES[c.status]?.dot || "bg-slate-300"}`} />
                  <span className="font-mono text-xs text-slate-400 shrink-0">{c.caseId}</span>
                  <span className="truncate text-slate-700">{c.title || "Untitled"}</span>
                </button>
              ))}
              {!isCol && vis.length === 0 && canEdit && (
                <button onClick={() => addCase(s.id)} className="w-full px-6 py-1.5 text-left text-xs text-indigo-500 hover:text-indigo-700">
                  + first test case
                </button>
              )}
            </div>
            );
          })}
        </aside>
        )}
        {view === "editor" && (
          <div onMouseDown={startResize} title="Drag to resize the list"
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
              priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter}
              typeFilter={typeFilter} setTypeFilter={setTypeFilter}
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
              Select a test case from the list or create a new one.
            </div>
          ) : (
            <div className="max-w-4xl mx-auto p-6 space-y-5">
              {/* title row */}
              <div className="flex items-start gap-3">
                <span className="font-mono text-sm text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 w-28 text-center select-all"
                  title="Auto-assigned, unique — cannot be changed">{tc.caseId}</span>
                <input
                  className="flex-1 text-lg font-semibold bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none placeholder-slate-400 placeholder:italic"
                  value={tc.title} onChange={(e) => setField("title", e.target.value)}
                  placeholder='Title — e.g. "Login with valid credentials"' readOnly={!canEdit} />
                {canEdit && (
                <button onClick={() => deleteCase(tc.id)} title={confirmDelete === `case-${tc.id}` ? "Click again to delete" : "Delete"}
                  className={`p-2.5 rounded-lg border ${confirmDelete === `case-${tc.id}` ? "bg-rose-50 border-rose-300 text-rose-600 text-xs font-semibold" : "text-slate-400 hover:text-rose-600 bg-white border-slate-200"}`}>
                  {confirmDelete === `case-${tc.id}` ? "Sure?" : <Trash2 size={16} />}
                </button>
                )}
              </div>

              {/* status bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex flex-col gap-3">
                  {/* status grupa */}
                  <div className="bg-slate-50/70 border border-slate-200 rounded-lg px-3 py-2 self-start">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Status</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {Object.entries(STATUSES).map(([key, cfg]) => (
                        <button key={key} onClick={() => setStatus(key)} disabled={!canEdit}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                            tc.status === key ? cfg.chip + " ring-2 ring-offset-1 ring-indigo-300" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"}`}>
                          {cfg.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-stretch gap-3">
                  {/* prioritet grupa */}
                  <div className="bg-slate-50/70 border border-slate-200 rounded-lg px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Priority</p>
                    <div className="flex items-center gap-1.5">
                      {Object.entries(PRIORITIES).map(([k, cfg]) => (
                        <button key={k} onClick={() => canEdit && setField("priority", k)} disabled={!canEdit}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                            (tc.priority || "medium") === k ? cfg.chip + " ring-2 ring-offset-1 ring-indigo-300" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"}`}>
                          {cfg.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* tip grupa */}
                  <div className="bg-slate-50/70 border border-slate-200 rounded-lg px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Type</p>
                    <div className="flex items-center gap-1.5">
                      {Object.entries(CASE_TYPES).map(([k, cfg]) => (
                        <button key={k} onClick={() => canEdit && setField("caseType", k)} disabled={!canEdit}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                            (tc.caseType || "positive") === k ? cfg.chip + " ring-2 ring-offset-1 ring-indigo-300" : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"}`}>
                          {cfg.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  </div>
                </div>
                {tc.executedAt && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-mono text-slate-500">
                    <Clock size={13} />
                    {STATUSES[tc.status].label} · {tc.executedBy}{tc.history?.[0]?.task ? <> · <TaskLink task={tc.history[0].task} /></> : ""} · {fmtTime(tc.executedAt)}
                  </p>
                )}
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

              {/* biznis dokumentacija */}
              <Field label="Biznis dokumentacija" hint="business context — up to 3 photos and text"
                value={tc.businessDocumentation} onChange={(v) => setField("businessDocumentation", v)}
                onPaste={canEdit ? handleBizDocPaste : undefined} readOnly={!canEdit}>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(tc.businessDocumentationImages || []).map((im, i) => (
                    <span key={im.path} className="inline-flex items-center gap-1">
                      <button
                        onMouseEnter={(e) => showPreview(e, im.url || im.path)}
                        onMouseMove={(e) => showPreview(e, im.url || im.path)}
                        onMouseLeave={hidePreview}
                        onClick={() => { hidePreview(); setLightbox(im.url || im.path); }}
                        className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md px-2 py-1">
                        <ImageIcon size={13} /> photo {i + 1}
                      </button>
                      {canEdit && (
                      <button onClick={() => removeBizDocImage(im.path)}
                        className="text-slate-300 hover:text-rose-500 p-0.5" title="Remove photo">
                        <X size={13} />
                      </button>
                      )}
                    </span>
                  ))}
                  {canEdit && (tc.businessDocumentationImages || []).length < MAX_BIZ_DOC_IMAGES && (
                    <label className="cursor-pointer flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 border border-dashed border-slate-300 hover:border-indigo-300 rounded-md px-2 py-1">
                      <ImageIcon size={13} /> Add photo
                      <input type="file" accept="image/*" className="hidden" onChange={handleBizDocFile} />
                    </label>
                  )}
                </div>
              </Field>

              {/* preconditions */}
              <Field label="Preconditions" hint="what must be in place before the test starts"
                value={tc.preconditions} onChange={(v) => setField("preconditions", v)} readOnly={!canEdit} />

              {/* steps */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Test Steps</p>
                  <p className="ml-auto text-xs text-slate-400">Screenshot: Ctrl+V directly into a step field</p>
                </div>
                <div className="space-y-2">
                  {tc.steps.map((s, i) => (
                    <div key={s.id} className={`border rounded-lg p-3 ${
                      s.mark === "fail" ? "border-rose-300 bg-rose-50/40"
                      : s.mark === "review" ? "border-amber-300 bg-amber-50/40"
                      : "border-slate-200 bg-slate-50/50"}`}>
                      <div className="flex gap-3">
                        <div className="flex flex-col items-center gap-1 pt-1">
                          <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 rounded-md w-7 h-7 flex items-center justify-center">{i + 1}</span>
                          {canEdit && <button onClick={() => moveStep(i, -1)} className="text-slate-300 hover:text-slate-600"><ChevronUp size={14} /></button>}
                          {canEdit && <button onClick={() => moveStep(i, 1)} className="text-slate-300 hover:text-slate-600"><ChevronDown size={14} /></button>}
                          {canEdit && (
                          <button onClick={() => removeStep(s.id)} title={confirmDelete === `step-${s.id}` ? "Click again to delete" : "Delete step"}
                            className={`mt-1 p-1 rounded-md ${confirmDelete === `step-${s.id}` ? "text-rose-600 bg-rose-50" : "text-slate-300 hover:text-rose-500"}`}>
                            {confirmDelete === `step-${s.id}` ? <span className="text-[9px] font-bold">Sure?</span> : <Trash2 size={14} />}
                          </button>
                          )}
                        </div>
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
                          <textarea rows={2} readOnly={!canEdit} value={s.action}
                            onChange={(e) => setStep(s.id, "action", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id, "action")}
                            placeholder={"Action — e.g. \"Enter email, click Login\""}
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                          <textarea rows={2} readOnly={!canEdit} value={s.testData || ""}
                            onChange={(e) => setStep(s.id, "testData", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id, "testData")}
                            placeholder={"Test data — e.g.\nuser@test.com / 123456"}
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                          <textarea rows={2} readOnly={!canEdit} value={s.expected}
                            onChange={(e) => setStep(s.id, "expected", e.target.value)}
                            onPaste={(e) => handlePaste(e, s.id, "expected")}
                            placeholder={"Expected — e.g. \"Redirect to dashboard\""}
                            className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-2 focus:border-indigo-400 outline-none resize-y placeholder-slate-400 placeholder:italic" />
                        </div>
                        <div className="flex flex-col gap-1 items-end">
                          {canEdit && (
                          <label className="cursor-pointer text-slate-400 hover:text-indigo-600 p-1" title="Add image">
                            <ImageIcon size={16} />
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e, s.id)} />
                          </label>
                          )}
                          {(canEdit || s.mark === "fail") && (
                          <button onClick={() => canEdit && setStep(s.id, "mark", s.mark === "fail" ? null : "fail")}
                            disabled={!canEdit} title="Mark step as failed"
                            className={`w-6 h-6 rounded-md border text-xs font-bold transition-colors ${
                              s.mark === "fail" ? "bg-rose-100 text-rose-700 border-rose-300"
                              : "bg-white text-slate-300 border-slate-200 hover:text-rose-500 hover:border-rose-300"}`}>✗</button>
                          )}
                          {(canEdit || s.mark === "review") && (
                          <button onClick={() => canEdit && setStep(s.id, "mark", s.mark === "review" ? null : "review")}
                            disabled={!canEdit} title="Mark step for consultation"
                            className={`w-6 h-6 rounded-md border text-xs font-bold transition-colors ${
                              s.mark === "review" ? "bg-amber-100 text-amber-700 border-amber-300"
                              : "bg-white text-slate-300 border-slate-200 hover:text-amber-500 hover:border-amber-300"}`}>?</button>
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
                            className="text-slate-300 hover:text-rose-500 p-0.5" title="Remove image">
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
                  <Plus size={15} /> Add step
                </button>
                )}
              </div>

              {/* actual / post / notes */}
              <Field label="Actual Result" hint="what actually happened — paste a screenshot with Ctrl+V"
                value={tc.actualResult} onChange={(v) => setField("actualResult", v)}
                onPaste={canEdit ? handleActualPaste : undefined} readOnly={!canEdit}>
                {(tc.actualResultImages || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {tc.actualResultImages.map((im, i) => (
                      <span key={im.path} className="inline-flex items-center gap-1">
                        <button
                          onMouseEnter={(e) => showPreview(e, im.url || im.path)}
                          onMouseMove={(e) => showPreview(e, im.url || im.path)}
                          onMouseLeave={hidePreview}
                          onClick={() => { hidePreview(); setLightbox(im.url || im.path); }}
                          className="flex items-center gap-1.5 text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-md px-2 py-1">
                          <ImageIcon size={13} /> screenshot {i + 1}
                        </button>
                        {canEdit && (
                        <button onClick={() => removeActualImage(im.path)}
                          className="text-slate-300 hover:text-rose-500 p-0.5" title="Remove image">
                          <X size={13} />
                        </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="Postconditions" hint="system state after the test finishes"
                value={tc.postconditions} onChange={(v) => setField("postconditions", v)} readOnly={!canEdit} />
              <Field label="Notes / Comments" hint="additional notes, observations, links"
                value={tc.notes} onChange={(v) => setField("notes", v)} readOnly={!canEdit} />

              {/* istorija statusa - skroz na dnu, sklopiva */}
              {tc.history?.length > 0 && (
                <details className="bg-white border border-slate-200 rounded-xl p-4">
                  <summary className="text-xs font-semibold uppercase tracking-wider text-slate-500 cursor-pointer hover:text-slate-700">
                    Status history ({tc.history.length})
                  </summary>
                  <ul className="mt-3 space-y-1">
                    {tc.history.map((h, i) => (
                      <li key={i} className="text-xs font-mono text-slate-500 flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUSES[h.status]?.dot}`} />
                        {STATUSES[h.status]?.label} — {h.by}{h.task ? <> — <TaskLink task={h.task} /></> : ""} — {fmtTime(h.at)}
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
      {importOpen && (
        <ImportModal
          suites={suites}
          index={index}
          userName={userName}
          task={task}
          onDone={handleImported}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}
