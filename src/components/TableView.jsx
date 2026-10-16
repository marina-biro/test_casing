import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, ChevronDown, Printer, Save, Image as ImageIcon } from "lucide-react";
import { STATUSES, PRIORITIES, CASE_TYPES, ENVIRONMENTS, fmtTime } from "../lib.js";
import { Linkified, TaskLink } from "./Linkified.jsx";

const COLUMNS = [
  { key: "caseId",        name: "Test Case ID",    w: "w-28" },
  { key: "title",         name: "Test Case",       w: "min-w-[180px]" },
  { key: "businessDocumentation", name: "Biznis dokumentacija", w: "min-w-[150px]" },
  { key: "preconditions", name: "Preconditions",   w: "min-w-[150px]" },
  { key: "steps",         name: "Test Steps",      w: "min-w-[240px]" },
  { key: "testData",      name: "Test Data",       w: "min-w-[160px]" },
  { key: "expected",      name: "Expected Result", w: "min-w-[200px]" },
  { key: "actualResult",  name: "Actual Result",   w: "min-w-[150px]" },
  { key: "status",        name: "Status",          w: "w-40" },
  { key: "priority",      name: "Priority",        w: "w-24" },
  { key: "caseType",      name: "Type",            w: "w-24" },
  { key: "task",          name: "Task",            w: "w-28" },
  { key: "postconditions",name: "Postconditions",  w: "min-w-[140px]" },
  { key: "environment",   name: "Environment",     w: "min-w-[120px]" },
  { key: "notes",         name: "Notes",           w: "min-w-[140px]" },
];

export default function TableView({ suites, index, allCases, loading, onStatusChange, onOpenCase, onShowPreview, onHidePreview, onLightbox, collapsed, onToggleCollapse,
  canEdit, q, setQ, taskQ, setTaskQ, statusFilter, setStatusFilter, envFilter, setEnvFilter,
  priorityFilter, setPriorityFilter, typeFilter, setTypeFilter }) {
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
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm font-mono">Loading table…</div>;
  }
  if (index.length === 0) {
    return <div className="h-full flex items-center justify-center text-slate-400 text-sm">No test cases to show — proveri filter ili dodaj nove.</div>;
  }

  const cols = COLUMNS.filter((c) => !hiddenCols.has(c.key));

  // da li TC prolazi sve aktivne filtere; task se trazi kroz CELU istoriju:
  // TC testiran juce pod PA-3737 a danas pod PA-2229 izlazi za OBA filtera
  const passes = (c) => {
    if (statusFilter !== null && !statusFilter.has(c.status)) return false;
    if (envFilter !== null && !(c.environment || []).some((e) => envFilter.has(e))) return false;
    if (priorityFilter !== null && !priorityFilter.has(c.priority || "medium")) return false;
    if (typeFilter !== null && !typeFilter.has(c.caseType || "positive")) return false;
    const full = allCases?.[c.id] || c;
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
  const anyFilterActive = statusFilter !== null || envFilter !== null || priorityFilter !== null || typeFilter !== null || q.trim() || taskQ.trim();

  // ---------- izvoz u PDF (print-to-PDF) ----------
  const exportPdf = async () => {
    const groups = suites
      .map((s) => ({
        suite: s,
        cases: index.filter((c) => c.suiteId === s.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).filter(passes)
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
      (c.actualResultImages || []).forEach((im) => {
        const au = im.url || (im.path?.startsWith("data:") ? im.path : null);
        if (au) urls.push(au);
      });
      (c.businessDocumentationImages || []).forEach((im) => {
        const bu = im.url || (im.path?.startsWith("data:") ? im.path : null);
        if (bu) urls.push(bu);
      });
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
      case "businessDocumentation":
        return <td key={col.key} rowSpan={span} className={cls}>
          <span className="flex items-start gap-1.5">
            <span className="flex-1"><Linkified text={c.businessDocumentation} /></span>
            {(c.businessDocumentationImages || []).length > 0 && (
              <span className="flex flex-col gap-0.5 shrink-0">
                {c.businessDocumentationImages.map((im) => (
                  <button key={im.path}
                    onMouseEnter={(e) => onShowPreview(e, im.url || im.path)}
                    onMouseMove={(e) => onShowPreview(e, im.url || im.path)}
                    onMouseLeave={onHidePreview}
                    onClick={() => { onHidePreview(); onLightbox(im.url || im.path); }}
                    className="text-indigo-500 hover:text-indigo-700" title="Photo — hover to preview">
                    <ImageIcon size={13} />
                  </button>
                ))}
              </span>
            )}
          </span>
        </td>;
      case "preconditions":
        return <td key={col.key} rowSpan={span} className={cls}><Linkified text={c.preconditions} /></td>;
      case "actualResult":
        return <td key={col.key} rowSpan={span} className={cls}>
          <span className="flex items-start gap-1.5">
            <span className="flex-1"><Linkified text={c.actualResult} /></span>
            {(c.actualResultImages || []).length > 0 && (
              <span className="flex flex-col gap-0.5 shrink-0">
                {c.actualResultImages.map((im) => (
                  <button key={im.path}
                    onMouseEnter={(e) => onShowPreview(e, im.url || im.path)}
                    onMouseMove={(e) => onShowPreview(e, im.url || im.path)}
                    onMouseLeave={onHidePreview}
                    onClick={() => { onHidePreview(); onLightbox(im.url || im.path); }}
                    className="text-indigo-500 hover:text-indigo-700" title="Screenshot — hover to preview">
                    <ImageIcon size={13} />
                  </button>
                ))}
              </span>
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
      case "priority": {
        const cfg = PRIORITIES[c.priority || "medium"] || PRIORITIES.medium;
        return <td key={col.key} rowSpan={span} className={cls}>
          <span className={`inline-block text-xs rounded-full border px-2 py-0.5 ${cfg.chip}`}>{cfg.label}</span>
        </td>;
      }
      case "caseType": {
        const cfg = CASE_TYPES[c.caseType || "positive"] || CASE_TYPES.positive;
        return <td key={col.key} rowSpan={span} className={cls}>
          <span className={`inline-block text-xs rounded-full border px-2 py-0.5 ${cfg.chip}`}>{cfg.label}</span>
        </td>;
      }
      case "task": {
        const lastTask = c.history?.[0]?.task || c.task || null;
        return <td key={col.key} rowSpan={span} className={`${cls} font-mono`}><TaskLink task={lastTask} /></td>;
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
            <span className={`font-mono text-[10px] font-bold rounded px-1.5 py-0.5 leading-none shrink-0 mt-0.5 border ${
              st.mark === "fail" ? "text-rose-700 bg-rose-50 border-rose-200"
              : st.mark === "review" ? "text-amber-700 bg-amber-50 border-amber-200"
              : "text-indigo-600 bg-indigo-50 border-indigo-100"}`}>
              {i + 1}{st.mark === "fail" ? " ✗" : st.mark === "review" ? " ?" : ""}
            </span>
            <span className="flex-1"><Linkified text={st.action} /></span>
          </span>
        </td>;
      case "testData":
        return <td key={col.key} className={cls}><Linkified text={st.testData || (i === 0 ? c.testData : "")} /></td>;
      case "expected":
        return <td key={col.key} className={cls}>
          <span className="flex items-start gap-1.5">
            <span className="flex-1"><Linkified text={st.expected} /></span>
            {st.image && (
              <button
                onMouseEnter={(e) => onShowPreview(e, st.imageUrl || st.image)}
                onMouseMove={(e) => onShowPreview(e, st.imageUrl || st.image)}
                onMouseLeave={onHidePreview}
                onClick={() => { onHidePreview(); onLightbox(st.imageUrl || st.image); }}
                className="text-indigo-500 hover:text-indigo-700 shrink-0" title="Screenshot — hover to preview">
                <ImageIcon size={13} />
              </button>
            )}
          </span>
        </td>;
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
              className="text-[11px] text-indigo-600 hover:underline">Check all</button>
            <button onClick={() => setStatusFilter(new Set())}
              className="text-[11px] text-indigo-600 hover:underline">Uncheck all</button>
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
              className="text-[11px] text-indigo-600 hover:underline">Check all</button>
            <button onClick={() => setEnvFilter(new Set())}
              className="text-[11px] text-indigo-600 hover:underline">Uncheck all</button>
          </div>
        </FilterButton>
        <FilterButton
          label="Priority"
          active={priorityFilter !== null}
          open={openPanel === "priority"}
          onToggle={() => setOpenPanel(openPanel === "priority" ? null : "priority")}>
          {Object.entries(PRIORITIES).map(([k, cfg]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer py-1">
              <input type="checkbox" checked={priorityFilter === null || priorityFilter.has(k)}
                onChange={() => setPriorityFilter((p) => excelToggle(p, k, Object.keys(PRIORITIES)))}
                className="accent-indigo-600" />
              {cfg.label}
            </label>
          ))}
          <div className="flex gap-3 mt-2 pt-2 border-t border-slate-100">
            <button onClick={() => setPriorityFilter(null)}
              className="text-[11px] text-indigo-600 hover:underline">Check all</button>
            <button onClick={() => setPriorityFilter(new Set())}
              className="text-[11px] text-slate-400 hover:underline">Uncheck all</button>
          </div>
        </FilterButton>
        <FilterButton
          label="Type"
          active={typeFilter !== null}
          open={openPanel === "type"}
          onToggle={() => setOpenPanel(openPanel === "type" ? null : "type")}>
          {Object.entries(CASE_TYPES).map(([k, cfg]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer py-1">
              <input type="checkbox" checked={typeFilter === null || typeFilter.has(k)}
                onChange={() => setTypeFilter((p) => excelToggle(p, k, Object.keys(CASE_TYPES)))}
                className="accent-indigo-600" />
              {cfg.label}
            </label>
          ))}
          <div className="flex gap-3 mt-2 pt-2 border-t border-slate-100">
            <button onClick={() => setTypeFilter(null)}
              className="text-[11px] text-indigo-600 hover:underline">Check all</button>
            <button onClick={() => setTypeFilter(new Set())}
              className="text-[11px] text-slate-400 hover:underline">Uncheck all</button>
          </div>
        </FilterButton>

        {(statusFilter !== null || envFilter !== null || priorityFilter !== null || typeFilter !== null || taskQ) && (
          <button onClick={() => { setStatusFilter(null); setEnvFilter(null); setPriorityFilter(null); setTypeFilter(null); setTaskQ(""); }}
            className="text-xs text-indigo-600 hover:text-indigo-800 underline underline-offset-2">
            Clear filters
          </button>
        )}
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search — ID or title…"
            className="text-xs border border-slate-200 rounded-lg pl-3 pr-7 py-1.5 w-56 outline-none focus:border-indigo-400 bg-white" />
          {q && (
            <button onClick={() => setQ("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
              <X size={13} />
            </button>
          )}
        </div>
        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Save size={13} className="animate-pulse" /> loading details…
          </span>
        )}
        <button onClick={exportPdf}
          title="Export what currently passes the filters"
          className="text-xs border border-slate-200 bg-white rounded-lg px-3 py-1.5 text-slate-600 hover:border-indigo-300 flex items-center gap-1.5">
          <Printer size={13} /> PDF
        </button>
        <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <input value={taskQ} onChange={(e) => setTaskQ(e.target.value)}
            placeholder="Task — e.g. PA-1234"
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
          label={`Columns (${cols.length}/${COLUMNS.length})`}
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
                  No test cases match the filters/search — change the selection or clear the search.
                </td>
              </tr>
            )}
            {suites.map((s) => {
              const rows = index.filter((c) => c.suiteId === s.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).filter(passes);
              if (rows.length === 0) return null;
              const isCollapsed = collapsed.has(s.id) && !q.trim() && !taskQ.trim(); // pretraga/task gledaju i kroz skupljene
              return [
                <tr key={s.id}>
                  <td colSpan={cols.length}
                    onClick={() => onToggleCollapse(s.id)}
                    className="border-x border-slate-200 border-t-2 border-t-slate-300 bg-indigo-50/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700 cursor-pointer select-none hover:bg-indigo-100/70"
                    title={isCollapsed ? "Expand" : "Collapse"}>
                    <span className="inline-flex items-center gap-1.5">
                      <ChevronDown size={13} className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                      {s.name}
                      <span className="font-mono text-[10px] text-indigo-400 normal-case">({rows.length})</span>
                    </span>
                  </td>
                </tr>,
                ...(isCollapsed ? [] : [
                rows.flatMap((row, tcIdx) => {
                  // pun TC ako je vec ucitan; u suprotnom lagani red iz indeksa (dok pozadina dopuni)
                  const c = allCases?.[row.id] || row;
                  const steps = c.steps && c.steps.length > 0
                    ? c.steps
                    : [{ id: "none", action: "", testData: "", expected: "", image: null }];
                  const zebra = tcIdx % 2 === 1 ? "bg-slate-50" : "bg-white";
                  return steps.map((st, i) => {
                    // deblja linija na pocetku TC-a, tanja svetlija izmedju koraka
                    const topCls = i === 0 ? "border-t-2 border-t-slate-300" : "border-t border-t-slate-200";
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
      <p className="sub">Generated: {today}</p>

      <div className="summary">
        <h2>Scenario overview</h2>
        <table>
          <thead>
            <tr><th>Suite</th><th>ID</th><th>Title</th><th>Priority</th><th>Type</th><th>Status</th><th>Last change</th></tr>
          </thead>
          <tbody>
            {allCasesFlat.map((c) => (
              <tr key={c.id}>
                <td>{c._suite}</td>
                <td style={{ fontFamily: "monospace" }}>{c.caseId}</td>
                <td>{c.title || "—"}</td>
                <td>{PRIORITIES[c.priority || "medium"]?.label}</td>
                <td>{CASE_TYPES[c.caseType || "positive"]?.label}</td>
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
                <span><span className="tc-id">{c.caseId}</span>{"  "}<span className="tc-title">{c.title || "Untitled"}</span></span>
                <span>
                  <span className="badge">{PRIORITIES[c.priority || "medium"]?.label}</span>{" "}
                  <span className="badge">{CASE_TYPES[c.caseType || "positive"]?.label}</span>{" "}
                  <span className="badge">{STATUSES[c.status]?.label || c.status}</span>
                </span>
              </div>
              {c.history?.[0]?.task && <p className="meta"><b>Task:</b> {c.history[0].task}</p>}
              {(c.environment || []).length > 0 && <p className="meta"><b>Environment:</b> {c.environment.join(", ")}</p>}
              {(c.businessDocumentation || (c.businessDocumentationImages || []).length > 0) && (
                <p className="meta"><b>Biznis dokumentacija:</b> {c.businessDocumentation || ""}
                  {(c.businessDocumentationImages || []).map((im) => {
                    const src = im.url || (im.path?.startsWith("data:") ? im.path : null);
                    return src ? <img key={im.path} className="thumb" src={src} alt="" /> : null;
                  })}
                </p>
              )}
              {c.preconditions && <p className="meta"><b>Preconditions:</b> {c.preconditions}</p>}

              {(c.steps || []).some((st) => st.action || st.expected || st.testData || st.image) && (
                <table>
                  <thead>
                    <tr><th style={{ width: "18px" }}>#</th><th>Action</th><th>Test data</th><th>Expected</th></tr>
                  </thead>
                  <tbody>
                    {c.steps.map((st, i) => (
                      <tr key={st.id}>
                        <td style={{ fontFamily: "monospace", color: st.mark === "fail" ? "#be123c" : st.mark === "review" ? "#b45309" : undefined }}>
                          {i + 1}{st.mark === "fail" ? " ✗" : st.mark === "review" ? " ?" : ""}
                        </td>
                        <td>{st.action || "—"}</td>
                        <td>{st.testData || "—"}</td>
                        <td>
                          {st.expected || "—"}
                          {imgSrc(st.image, st.imageUrl) && <img className="thumb" src={imgSrc(st.image, st.imageUrl)} alt="" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {(c.actualResult || (c.actualResultImages || []).length > 0) && (
                <p className="meta"><b>Actual Result:</b> {c.actualResult || ""}
                  {(c.actualResultImages || []).map((im) => {
                    const src = im.url || (im.path?.startsWith("data:") ? im.path : null);
                    return src ? <img key={im.path} className="thumb" src={src} alt="" /> : null;
                  })}
                </p>
              )}
              {c.postconditions && <p className="meta"><b>Postconditions:</b> {c.postconditions}</p>}
              {c.notes && <p className="meta"><b>Notes:</b> {c.notes}</p>}
              {c.history?.[0] && (
                <p className="hist" style={{ marginTop: "4px" }}>
                  {STATUSES[c.history[0].status]?.label || c.history[0].status} — {c.history[0].by}{c.history[0].task ? ` — ${c.history[0].task}` : ""} — {fmtTime(c.history[0].at)}
                </p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
