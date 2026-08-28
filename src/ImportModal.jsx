import { useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Upload, X, Check, AlertTriangle, FileText, Loader2 } from "lucide-react";

// ---------- iste konstante kao u QATestCaseTool.jsx ----------
const STATUS_KEYS = ["created", "not_executed", "pass", "fail", "review", "blocked"];
const PRIORITY_KEYS = ["core", "medium", "edge"];
const CASE_TYPE_KEYS = ["positive", "negative"];
const ENVIRONMENTS = ["Chrome", "Firefox", "Safari", "Edge", "iPhone", "Android", "Tablet", "API"];

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const sGet = async (key) => {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
};
const sSet = async (key, val) => {
  const r = await window.storage.set(key, JSON.stringify(val));
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};

// ---------- CSV parser (RFC 4180: kvote, duple kvote, novi red u polju) ----------
function parseCSV(text) {
  const s = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------- mapiranje zaglavlja: srpski i engleski nazivi ----------
const HEADER_ALIASES = {
  suite:          ["suite", "suita", "grupa", "group"],
  caseId:         ["case_id", "caseid", "id", "tc_id", "sifra"],
  title:          ["title", "naslov", "name", "naziv"],
  objective:      ["objective", "cilj", "svrha"],
  preconditions:  ["preconditions", "preduslovi", "preduslov"],
  testData:       ["test_data", "testdata", "testni_podaci", "podaci"],
  postconditions: ["postconditions", "postuslovi"],
  environment:    ["environment", "okruzenje", "okruženje", "env"],
  notes:          ["notes", "napomena", "napomene", "note"],
  priority:       ["priority", "prioritet"],
  caseType:       ["case_type", "casetype", "tip", "type"],
  status:         ["status"],
  steps:          ["steps", "koraci", "korak"],
  expected:       ["expected", "ocekivano", "očekivano", "expected_result", "ocekivani_rezultat"],
};

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, i) => {
    const h = raw.trim().toLowerCase().replace(/\s+/g, "_");
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(h)) { map[field] = i; break; }
    }
  });
  return map;
}

// ---------- normalizacija vrednosti ----------
// dozvoljava i Critical/High/Medium/Low iz eksternih fajlova
const PRIORITY_MAP = {
  critical: "core", core: "core", high: "medium", visok: "medium",
  medium: "medium", srednji: "medium", low: "edge", edge: "edge", nizak: "edge",
};

function normPriority(v) {
  const k = (v || "").trim().toLowerCase();
  if (!k) return { value: "medium", warn: null };
  const mapped = PRIORITY_MAP[k];
  if (mapped) return { value: mapped, warn: null };
  return { value: "medium", warn: `nepoznat prioritet "${v}", postavljen medium` };
}

function normEnum(v, allowed, fallback, label) {
  const k = (v || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!k) return { value: fallback, warn: null };
  if (allowed.includes(k)) return { value: k, warn: null };
  return { value: fallback, warn: `nepoznat ${label} "${v}", postavljen ${fallback}` };
}

function normEnvironment(v) {
  if (!v || !v.trim()) return { value: [], warn: null };
  const parts = v.split(/[,;/]/).map((p) => p.trim()).filter(Boolean);
  const out = [], bad = [];
  for (const p of parts) {
    const hit = ENVIRONMENTS.find((e) => e.toLowerCase() === p.toLowerCase());
    if (hit) { if (!out.includes(hit)) out.push(hit); } else bad.push(p);
  }
  return { value: out, warn: bad.length ? `nepoznato okruženje: ${bad.join(", ")}` : null };
}

// "1. Otvori stranicu >> Stranica se ucitava" -> {action, expected}
// podrzano i "akcija || testni podaci || ocekivano"
function parseSteps(cell, overallExpected) {
  const lines = (cell || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const steps = lines.map((line) => {
    const clean = line.replace(/^\s*\d+[.)]\s*/, "");
    let action = clean, testData = "", expected = "";
    if (clean.includes("||")) {
      const p = clean.split("||").map((x) => x.trim());
      action = p[0] || ""; testData = p[1] || ""; expected = p[2] || "";
    } else if (clean.includes(">>")) {
      const p = clean.split(">>").map((x) => x.trim());
      action = p[0] || ""; expected = p[1] || "";
    }
    return { id: uid(), action, testData, expected, mark: null, image: null };
  });

  if (steps.length === 0) {
    steps.push({ id: uid(), action: "", testData: "", expected: "", mark: null, image: null });
  }
  // ocekivani rezultat celog slucaja ide na poslednji korak
  const exp = (overallExpected || "").trim();
  if (exp) {
    const last = steps[steps.length - 1];
    last.expected = last.expected ? `${last.expected}\n${exp}` : exp;
  }
  return steps;
}

// ---------- red -> objekat spreman za upis ----------
function buildRows(parsed, existingCaseIds) {
  const [headerRow, ...dataRows] = parsed;
  const cols = mapHeaders(headerRow);

  if (cols.title === undefined) {
    return { error: "Fajl nema kolonu title (ili naslov). Proveri prvi red.", rows: [], cols };
  }

  const seen = new Set();
  const rows = dataRows.map((r, i) => {
    const get = (f) => (cols[f] !== undefined ? (r[cols[f]] ?? "").trim() : "");
    const warns = [];
    const errs = [];

    const title = get("title");
    if (!title) errs.push("nedostaje title");

    const suite = get("suite") || "Uvezeno";

    const pr = normPriority(get("priority"));
    if (pr.warn) warns.push(pr.warn);
    const ct = normEnum(get("caseType"), CASE_TYPE_KEYS, "positive", "tip");
    if (ct.warn) warns.push(ct.warn);
    const st = normEnum(get("status"), STATUS_KEYS, "created", "status");
    if (st.warn) warns.push(st.warn);
    const env = normEnvironment(get("environment"));
    if (env.warn) warns.push(env.warn);

    const srcId = get("caseId");
    if (srcId) {
      if (existingCaseIds.has(srcId)) errs.push(`ID ${srcId} već postoji`);
      else if (seen.has(srcId)) errs.push(`ID ${srcId} se ponavlja u fajlu`);
      seen.add(srcId);
    }

    return {
      line: i + 2, // +2: 1 za zaglavlje, 1 jer je numeracija od jedan
      srcId,
      suite,
      title,
      objective: get("objective"),
      preconditions: get("preconditions"),
      testData: get("testData"),
      postconditions: get("postconditions"),
      notes: get("notes"),
      environment: env.value,
      priority: pr.value,
      caseType: ct.value,
      status: st.value,
      steps: parseSteps(get("steps"), get("expected")),
      warns,
      errs,
    };
  });

  return { error: null, rows, cols };
}

// JSON ulaz: niz objekata; koraci mogu biti niz stringova ili niz objekata
function rowsFromJson(arr, existingCaseIds) {
  const seen = new Set();
  return arr.map((o, i) => {
    const errs = [], warns = [];
    const title = (o.title || o.naslov || "").trim();
    if (!title) errs.push("nedostaje title");

    const pr = normPriority(o.priority || o.prioritet);
    if (pr.warn) warns.push(pr.warn);
    const ct = normEnum(o.caseType || o.case_type || o.tip, CASE_TYPE_KEYS, "positive", "tip");
    const st = normEnum(o.status, STATUS_KEYS, "created", "status");
    const env = normEnvironment(
      Array.isArray(o.environment) ? o.environment.join(",") : (o.environment || o.okruzenje || "")
    );
    if (env.warn) warns.push(env.warn);

    const srcId = (o.caseId || o.case_id || o.id || "").toString().trim();
    if (srcId) {
      if (existingCaseIds.has(srcId)) errs.push(`ID ${srcId} već postoji`);
      else if (seen.has(srcId)) errs.push(`ID ${srcId} se ponavlja u fajlu`);
      seen.add(srcId);
    }

    const rawSteps = o.steps || o.koraci || [];
    const stepsText = Array.isArray(rawSteps)
      ? rawSteps.map((s) => (typeof s === "string" ? s : [s.action, s.testData, s.expected].filter(Boolean).join(" || "))).join("\n")
      : String(rawSteps);

    return {
      line: i + 1,
      srcId,
      suite: (o.suite || o.grupa || "Uvezeno").trim(),
      title,
      objective: o.objective || o.cilj || "",
      preconditions: o.preconditions || o.preduslovi || "",
      testData: o.testData || o.test_data || "",
      postconditions: o.postconditions || o.postuslovi || "",
      notes: o.notes || o.napomena || "",
      environment: env.value,
      priority: pr.value,
      caseType: ct.value,
      status: st.value,
      steps: parseSteps(stepsText, o.expected || o.ocekivano || ""),
      warns,
      errs,
    };
  });
}

// ============================================================================
export default function ImportModal({ suites, index, userName, task, onDone, onClose }) {
  const [rows, setRows] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [fileName, setFileName] = useState("");
  const [keepIds, setKeepIds] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, failed, message}
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  const existingCaseIds = useMemo(
    () => new Set(index.map((c) => c.caseId).filter(Boolean)),
    [index]
  );

  const readFile = async (file) => {
    setParseError(null); setResult(null); setRows(null);
    setFileName(file.name);
    const text = await file.text();
    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("JSON mora biti niz objekata.");
        setRows(rowsFromJson(data, existingCaseIds));
      } else {
        const parsed = parseCSV(text);
        if (parsed.length < 2) throw new Error("Fajl nema nijedan red posle zaglavlja.");
        const { error, rows: r } = buildRows(parsed, existingCaseIds);
        if (error) throw new Error(error);
        setRows(r);
      }
    } catch (e) {
      setParseError(e.message || "Fajl nije moguće pročitati.");
    }
  };

  const hasSrcIds = rows?.some((r) => r.srcId);
  const blocking = rows?.filter((r) => r.errs.filter((e) => keepIds || !e.includes("ID")).length > 0) || [];
  const warnCount = rows?.reduce((n, r) => n + r.warns.length, 0) || 0;

  const newSuiteNames = useMemo(() => {
    if (!rows) return [];
    const have = new Set(suites.map((s) => s.name.trim().toLowerCase()));
    const out = [];
    for (const r of rows) {
      const k = r.suite.trim().toLowerCase();
      if (!have.has(k) && !out.some((n) => n.toLowerCase() === k)) out.push(r.suite.trim());
    }
    return out;
  }, [rows, suites]);

  const runImport = async () => {
    if (!rows || blocking.length > 0) return;
    setBusy(true); setResult(null);

    const nameToId = new Map(suites.map((s) => [s.name.trim().toLowerCase(), s.id]));
    const created = newSuiteNames.map((name, i) => {
      const s = { id: uid(), name, position: suites.length + i };
      nameToId.set(name.toLowerCase(), s.id);
      return s;
    });
    const nextSuites = [...suites, ...created];

    const by = userName?.trim() || "nepoznat korisnik";
    const activeTask = task?.trim() || null;
    const at = now();

    // case_id prazan -> RPC dodeljuje TC_xxx iz next_tc_seq
    const payloadCases = rows.map((r) => ({
      id: uid(),
      suiteId: nameToId.get(r.suite.trim().toLowerCase()),
      caseId: keepIds && r.srcId ? r.srcId : "",
      title: r.title,
      objective: r.objective,
      preconditions: r.preconditions,
      testData: r.testData,
      postconditions: r.postconditions,
      environment: r.environment,
      notes: r.notes,
      steps: r.steps,
      actualResult: "",
      actualResultImages: [],
      task: activeTask,
      priority: r.priority,
      caseType: r.caseType,
      status: r.status,
      createdBy: by,
      createdAt: at,
      executedBy: by,
      executedAt: at,
      history: [{ status: r.status, by, at, task: activeTask }],
    }));

    try {
      // jedan poziv, jedna transakcija: ili prodje sve ili ne prodje nista
      const res = await sSet("tc-import", { suites: created, cases: payloadCases });
      const assigned = new Map((res?.cases || []).map((c) => [c.id, c]));

      const madeCases = payloadCases.map((c) => {
        const a = assigned.get(c.id);
        return a ? { ...c, caseId: a.case_id, position: a.position } : c;
      });

      onDone({ suites: nextSuites, cases: madeCases });
      setResult({ ok: madeCases.length, failed: 0 });
    } catch (e) {
      // transakcija je ponistena - u bazi nije ostalo nista
      setResult({
        ok: 0,
        failed: rows.length,
        message: e?.message || String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">

        <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-200">
          <Upload size={16} className="text-indigo-600" />
          <h2 className="text-sm font-semibold text-slate-800">Import test cases</h2>
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-slate-400 hover:text-slate-600 disabled:opacity-30">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* --- izbor fajla --- */}
          {!rows && (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) readFile(f);
                }}
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-lg py-10 text-center cursor-pointer transition-colors ${
                  dragging ? "border-indigo-400 bg-indigo-50/60" : "border-slate-300 hover:border-indigo-400"}`}>
                <FileText size={22} className="mx-auto text-slate-400 mb-2" />
                <p className="text-sm text-slate-600">Prevuci CSV ili JSON, ili klikni da izabereš fajl</p>
                <p className="text-xs text-slate-400 mt-1">Prvi red je zaglavlje sa nazivima kolona</p>
              </div>
              <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }} />

              <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                <p className="font-semibold text-slate-600">Kolone koje se prepoznaju</p>
                <p><span className="font-mono text-slate-700">title</span> je obavezna. Opciono:
                  {" "}<span className="font-mono">suite, case_id, objective, preconditions, test_data,
                  postconditions, environment, notes, priority, case_type, status, steps, expected</span>.
                  Srpski nazivi rade takođe: naslov, grupa, preduslovi, koraci, ocekivano, prioritet, napomena.</p>
                <p><span className="font-mono text-slate-700">steps</span>: jedan korak po redu unutar ćelije.
                  Za očekivani rezultat po koraku koristi <span className="font-mono">akcija &gt;&gt; očekivano</span>,
                  a za sva tri polja <span className="font-mono">akcija || podaci || očekivano</span>.
                  Kolona <span className="font-mono">expected</span> ide na poslednji korak.</p>
                <p><span className="font-mono text-slate-700">priority</span>: core, medium, edge
                  (Critical, High, Low se automatski prevode).
                  {" "}<span className="font-mono">status</span>: {STATUS_KEYS.join(", ")}.</p>
              </div>
            </>
          )}

          {parseError && (
            <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Fajl nije učitan</p>
                <p className="text-xs mt-0.5">{parseError}</p>
              </div>
            </div>
          )}

          {/* --- pregled --- */}
          {rows && !result && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs bg-slate-100 rounded px-2 py-1 text-slate-600">{fileName}</span>
                <span className="text-slate-600">{rows.length} test case-ova</span>
                {newSuiteNames.length > 0 && (
                  <span className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">
                    {newSuiteNames.length} {newSuiteNames.length === 1 ? "nov suite" : "nova suite-a"}
                  </span>
                )}
                <button onClick={() => { setRows(null); setFileName(""); }} disabled={busy}
                  className="ml-auto text-xs text-slate-400 hover:text-slate-600 disabled:opacity-30">
                  Izaberi drugi fajl
                </button>
              </div>

              {newSuiteNames.length > 0 && (
                <p className="text-xs text-slate-500">
                  Kreiraće se: {newSuiteNames.join(", ")}
                </p>
              )}

              {hasSrcIds && (
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={keepIds} disabled={busy}
                    onChange={(e) => setKeepIds(e.target.checked)}
                    className="accent-indigo-600" />
                  Zadrži ID-jeve iz fajla
                  <span className="text-xs text-slate-400">
                    (isključeno: dodeljuju se TC_xxx iz brojača)
                  </span>
                </label>
              )}

              {blocking.length > 0 && (
                <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
                  <p className="font-medium flex items-center gap-1.5">
                    <AlertTriangle size={14} /> {blocking.length} {blocking.length === 1 ? "red se mora ispraviti" : "reda se moraju ispraviti"}
                  </p>
                  <ul className="text-xs mt-1.5 space-y-0.5">
                    {blocking.slice(0, 8).map((r) => (
                      <li key={r.line}>Red {r.line}: {r.errs.join("; ")}</li>
                    ))}
                    {blocking.length > 8 && <li>… i još {blocking.length - 8}</li>}
                  </ul>
                </div>
              )}

              {warnCount > 0 && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="font-medium">{warnCount} upozorenja — import će proći, vrednosti su zamenjene podrazumevanim</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {rows.filter((r) => r.warns.length).slice(0, 6).map((r) => (
                      <li key={r.line}>Red {r.line}: {r.warns.join("; ")}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="text-left font-medium px-3 py-2 w-20">ID</th>
                      <th className="text-left font-medium px-3 py-2 w-32">Suite</th>
                      <th className="text-left font-medium px-3 py-2">Title</th>
                      <th className="text-left font-medium px-3 py-2 w-16">Koraci</th>
                      <th className="text-left font-medium px-3 py-2 w-20">Prioritet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 60).map((r) => (
                      <tr key={r.line}
                        className={`border-t border-slate-100 ${r.errs.length ? "bg-rose-50/60" : ""}`}>
                        <td className="px-3 py-1.5 font-mono text-slate-400">
                          {keepIds && r.srcId ? r.srcId : "auto"}
                        </td>
                        <td className="px-3 py-1.5 text-slate-500 truncate max-w-[8rem]">{r.suite}</td>
                        <td className="px-3 py-1.5 text-slate-700">{r.title || <em className="text-rose-500">prazno</em>}</td>
                        <td className="px-3 py-1.5 text-slate-500">{r.steps.length}</td>
                        <td className="px-3 py-1.5 text-slate-500">{r.priority}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 60 && (
                  <p className="text-xs text-slate-400 px-3 py-2 border-t border-slate-100">
                    Prikazano prvih 60 od {rows.length}.
                  </p>
                )}
              </div>
            </>
          )}

          {/* --- rezultat --- */}
          {result && (
            <div className={`rounded-lg border p-4 ${result.failed
              ? "bg-amber-50 border-amber-200 text-amber-800"
              : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}>
              <p className="text-sm font-medium flex items-center gap-1.5">
                {result.failed ? <AlertTriangle size={15} /> : <Check size={15} />}
                {result.failed
                  ? "Import nije prošao — ništa nije upisano"
                  : `Uvezeno ${result.ok} test case-ova`}
              </p>
              {result.message && <p className="text-xs mt-1.5 font-mono">{result.message}</p>}
              {result.failed > 0 && (
                <>
                  <p className="text-xs mt-1.5">
                    Baza je vraćena u stanje pre importa. Ispravi fajl i pokušaj ponovo — nema šta da se čisti.
                  </p>
                  <button onClick={() => { setResult(null); setRows(null); setFileName(""); }}
                    className="text-xs font-medium underline mt-2">
                    Izaberi drugi fajl
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-200">
          {busy && (
            <span className="text-xs text-slate-500 flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" />
              Uvozim {rows?.length} test case-ova…
            </span>
          )}
          <button onClick={onClose} disabled={busy}
            className="ml-auto text-sm text-slate-500 hover:text-slate-700 px-3 py-2 disabled:opacity-30">
            {result ? "Zatvori" : "Odustani"}
          </button>
          {rows && !result && (
            <button onClick={runImport} disabled={busy || blocking.length > 0}
              className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg px-4 py-2 transition-colors">
              Uvezi {rows.length}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
