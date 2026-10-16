// storageShim.js - KORAK 2: Supabase implementacija
// Menja localStorage verziju. Isti window.storage API koji komponenta vec koristi,
// ali kljucevi se mapiraju na tabele u bazi:
//   tc-user      -> localStorage (ime po uredjaju; u koraku 4 dolazi iz logina)
//   tc-meta      -> tabela suites (+ lista slucajeva iz test_cases)
//   tc-case-{id} -> red u test_cases + redovi u status_history

import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// iz emaila ime.prezime@... izvodi prikazno ime "ime.p"
function nameFromEmail(email) {
  if (!email) return null;
  const local = email.split("@")[0];
  const parts = local.split(".").filter(Boolean);
  if (parts.length >= 2) return parts[0] + "." + parts[1][0];
  return local;
}

// ---------- screenshotovi (Supabase Storage) ----------
const BUCKET = "screenshots";
const SIGNED_URL_TTL = 60 * 60 * 24; // 24h

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// upload slike -> vraca {path, url}; path se cuva u bazi, url sluzi za prikaz
export async function uploadScreenshot(dataUrl) {
  const path = crypto.randomUUID() + ".jpg";
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, dataUrlToBlob(dataUrl), { contentType: "image/jpeg" });
  if (error) throw error;
  const { data, error: e2 } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (e2) throw e2;
  return { path, url: data.signedUrl };
}

// brise fajl iz bucketa; base64 i prazne vrednosti preskace
export async function deleteScreenshot(path) {
  if (!path || path.startsWith("data:")) return;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.error("Brisanje screenshota nije uspelo:", error);
}

// za korake ciji je image putanja u bucketu, dodaje imageUrl (potpisan link);
// stare base64 slike (data:...) ostaju netaknute i dalje rade
async function withSignedUrls(c) {
  const stepPaths = (c.steps || [])
    .filter((s) => s.image && !s.image.startsWith("data:"))
    .map((s) => s.image);
  const arPaths = (c.actualResultImages || []).map((im) => im.path).filter((p) => p && !p.startsWith("data:"));
  const bizPaths = (c.businessDocumentationImages || []).map((im) => im.path).filter((p) => p && !p.startsWith("data:"));
  const paths = [...stepPaths, ...arPaths, ...bizPaths];
  if (paths.length === 0) return c;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
  const urlMap = new Map((data || []).map((d) => [d.path, d.signedUrl]));
  return {
    ...c,
    steps: c.steps.map((s) =>
      s.image && !s.image.startsWith("data:")
        ? { ...s, imageUrl: urlMap.get(s.image) || null }
        : s
    ),
    actualResultImages: (c.actualResultImages || []).map((im) =>
      im.path && !im.path.startsWith("data:") ? { ...im, url: urlMap.get(im.path) || null } : im),
    businessDocumentationImages: (c.businessDocumentationImages || []).map((im) =>
      im.path && !im.path.startsWith("data:") ? { ...im, url: urlMap.get(im.path) || null } : im),
  };
}

// potpisi slike za CELU listu TC-ova jednim pozivom (umesto po TC-u)
async function withSignedUrlsBatch(cases) {
  const all = [];
  for (const c of cases) {
    (c.steps || []).forEach((st) => { if (st.image && !st.image.startsWith("data:")) all.push(st.image); });
    (c.actualResultImages || []).forEach((im) => { if (im.path && !im.path.startsWith("data:")) all.push(im.path); });
    (c.businessDocumentationImages || []).forEach((im) => { if (im.path && !im.path.startsWith("data:")) all.push(im.path); });
  }
  let urlMap = new Map();
  const CHUNK = 500; // siguran komad za createSignedUrls
  for (let i = 0; i < all.length; i += CHUNK) {
    const slice = all.slice(i, i + CHUNK);
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(slice, SIGNED_URL_TTL);
    (data || []).forEach((d) => urlMap.set(d.path, d.signedUrl));
  }
  return cases.map((c) => ({
    ...c,
    steps: (c.steps || []).map((st) =>
      st.image && !st.image.startsWith("data:") ? { ...st, imageUrl: urlMap.get(st.image) || null } : st),
    actualResultImages: (c.actualResultImages || []).map((im) =>
      im.path && !im.path.startsWith("data:") ? { ...im, url: urlMap.get(im.path) || null } : im),
    businessDocumentationImages: (c.businessDocumentationImages || []).map((im) =>
      im.path && !im.path.startsWith("data:") ? { ...im, url: urlMap.get(im.path) || null } : im),
  }));
}

// pamti poslednji poznat status po slucaju, da bismo znali kada je
// promena statusa (i samo tada upisali red u status_history)
const lastStatus = new Map();

// ---------- mapiranje red <-> objekat koji komponenta ocekuje ----------
function rowToCase(row, historyRows) {
  const history = (historyRows || []).map((h) => ({
    status: h.status,
    by: h.changed_by_name,
    at: h.changed_at,
    task: h.task || null,
  }));
  const latest = history[0] || null;
  return {
    id: row.id,
    suiteId: row.suite_id,
    caseId: row.case_id,
    title: row.title || "",
    objective: row.objective || "",
    businessDocumentation: row.business_documentation || "",
    businessDocumentationImages: (row.business_documentation_images || []).map((p) => ({ path: p, url: null })),
    preconditions: row.preconditions || "",
    testData: row.test_data || "",
    postconditions: row.postconditions || "",
    environment: row.environment || [],
    notes: row.notes || "",
    actualResult: row.actual_result || "",
    task: row.task || null,
    priority: row.priority || "medium",
    caseType: row.case_type || "positive",
    position: row.position ?? 0,
    actualResultImages: (row.actual_result_images || []).map((p) => ({ path: p, url: null })),
    steps: row.steps || [],
    status: row.status,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    executedBy: latest ? latest.by : null,
    executedAt: latest ? latest.at : null,
    history,
  };
}

function caseToRow(c) {
  return {
    id: c.id,
    suite_id: c.suiteId,
    case_id: c.caseId,
    title: c.title,
    objective: c.objective,
    business_documentation: c.businessDocumentation,
    business_documentation_images: (c.businessDocumentationImages || []).map((im) => im.path).filter(Boolean),
    preconditions: c.preconditions,
    test_data: c.testData,
    postconditions: c.postconditions,
    environment: c.environment || [],
    notes: c.notes,
    actual_result: c.actualResult,
    task: c.task || null,
    priority: c.priority || "medium",
    case_type: c.caseType || "positive",
    position: c.position ?? 0,
    actual_result_images: (c.actualResultImages || []).map((im) => im.path).filter(Boolean),
    // imageUrl je izveden (potpisan link), ne cuva se - u bazu ide samo putanja
    steps: (c.steps || []).map(({ imageUrl, ...rest }) => rest),
    status: c.status,
    created_by_name: c.createdBy || null,
  };
}

// ---------- window.storage ----------
window.storage = {
  async get(key) {
    if (key === "tc-user") {
      const _ta = performance.now();
      const { data: { user } } = await supabase.auth.getUser();
      console.log(`[perf] auth.getUser (tc-user): ${Math.round(performance.now()-_ta)}ms`);
      const name = nameFromEmail(user?.email);
      if (!name) throw new Error("Key not found: " + key);
      // JSON.stringify jer komponenta vrednosti cita kroz JSON.parse
      return { key, value: JSON.stringify(name), shared: false };
    }

    if (key === "tc-task") {
      const { data: { user } } = await supabase.auth.getUser();
      const v = user?.user_metadata?.active_task || "";
      return { key, value: JSON.stringify(v), shared: false };
    }

    if (key === "tc-next-seq") {
      const { data, error } = await supabase.rpc("next_tc_seq");
      if (error) throw error;
      return { key, value: JSON.stringify(data), shared: true };
    }


    if (key.startsWith("doc-proposals-")) {
      const area = key.slice("doc-proposals-".length);
      const { data, error } = await supabase
        .from("doc_proposals")
        .select("id, kind, entry_id, section, proposed_text, current_text, proposed_refs, rationale, sources, task")
        .eq("area", area)
        .eq("resolution", "pending")
        .order("created_at");
      if (error) throw error;
      return { key, value: JSON.stringify(data ?? []), shared: true };
    }

    if (key.startsWith("doc-entries-")) {
      const area = key.slice("doc-entries-".length);
      const { data, error } = await supabase
        .from("doc_entries")
        .select("id, section, text, refs, tasks, sources, version, position, updated_at, updated_by")
        .eq("area", area)
        .eq("status", "accepted")
        .order("section")
        .order("position");
      if (error) throw error;
      return { key, value: JSON.stringify(data ?? []), shared: true };
    }

    if (key === "tc-role") {
      const { data: { user } } = await supabase.auth.getUser();
      let role = "viewer";
      if (user) {
        const { data } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
        role = data?.role || "viewer";
      }
      return { key, value: JSON.stringify(role), shared: false };
    }

    if (key === "tc-meta") {
      const [{ data: suites, error: e1 }, { data: cases, error: e2 }] =
        await Promise.all([
          supabase.from("suites").select("id,name").order("position").order("created_at"),
          supabase.from("test_cases").select("id,suite_id,case_id,title,status,environment,priority,case_type,position").order("position"),
        ]);
      if (e1) throw e1;
      if (e2) throw e2;
      (cases || []).forEach((c) => lastStatus.set(c.id, c.status));
      const meta = {
        suites: (suites || []).map((s) => ({ id: s.id, name: s.name })),
        cases: (cases || []).map((c) => ({
          id: c.id,
          suiteId: c.suite_id,
          caseId: c.case_id,
          title: c.title || "",
          status: c.status,
          environment: c.environment || [],
          priority: c.priority || "medium",
          caseType: c.case_type || "positive",
          position: c.position ?? 0,
        })),
      };
      return { key, value: JSON.stringify(meta), shared: true };
    }

    if (key === "tc-cases-all") {
      // SVI TC-ovi + SVA istorija, u stranicama (Supabase vraca max 1000 redova/upitu)
      const pageAll = async (table, cols, order) => {
        const PAGE = 1000;
        let out = [], from = 0;
        for (;;) {
          let q = supabase.from(table).select(cols).range(from, from + PAGE - 1);
          if (order) q = q.order(order.col, { ascending: order.asc });
          const { data, error } = await q;
          if (error) throw error;
          out = out.concat(data || []);
          if (!data || data.length < PAGE) break;
          from += PAGE;
        }
        return out;
      };
      const _t0 = performance.now();
      const [rows, hist] = await Promise.all([
        pageAll("test_cases", "*", null),
        pageAll("status_history", "test_case_id,status,changed_by_name,changed_at,task",
                { col: "changed_at", asc: false }),
      ]);
      console.log(`[perf] DB upiti (${(rows||[]).length} TC, ${(hist||[]).length} istorija): ${Math.round(performance.now()-_t0)}ms`);
      // grupisi istoriju po TC-u (vec sortirana najnovije-prvo), max 20 po TC-u
      const histByCase = new Map();
      for (const h of hist || []) {
        const arr = histByCase.get(h.test_case_id) || [];
        if (arr.length < 20) { arr.push(h); histByCase.set(h.test_case_id, arr); }
      }
      (rows || []).forEach((r) => lastStatus.set(r.id, r.status));
      const _t1 = performance.now();
      const cases = await withSignedUrlsBatch(
        (rows || []).map((r) => rowToCase(r, histByCase.get(r.id) || []))
      );
      console.log(`[perf] potpisivanje slika: ${Math.round(performance.now()-_t1)}ms`);
      const map = Object.fromEntries(cases.map((c) => [c.id, c]));
      return { key, value: JSON.stringify(map), shared: true };
    }

    if (key.startsWith("tc-case-")) {
      const id = key.slice("tc-case-".length);
      const [{ data: row, error: e1 }, { data: hist, error: e2 }] =
        await Promise.all([
          supabase.from("test_cases").select("*").eq("id", id).maybeSingle(),
          supabase.from("status_history").select("status,changed_by_name,changed_at,task")
            .eq("test_case_id", id).order("changed_at", { ascending: false }).limit(20),
        ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (!row) throw new Error("Key not found: " + key);
      lastStatus.set(row.id, row.status);
      const full = await withSignedUrls(rowToCase(row, hist));
      return { key, value: JSON.stringify(full), shared: true };
    }

    throw new Error("Key not found: " + key);
  },

  async set(key, value) {
    if (key === "tc-user") {
      // ime je uvek izvedeno iz emaila (ime.p) - rucna izmena nije dozvoljena
      return { key, value, shared: false };
    }

    if (key === "tc-task") {
      await supabase.auth.updateUser({ data: { active_task: JSON.parse(value) } });
      return { key, value, shared: false };
    }

    if (key === "doc-generate") {
      // Edge funkcija drzi ANTHROPIC_API_KEY kao secret; kljuc nikad ne dolazi
      // u browser. Korisnikov JWT ide dalje, pa RLS vazi i u funkciji.
      const body = JSON.parse(value);
      const { data, error } = await supabase.functions.invoke("generate-doc", { body });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.json())?.error ?? detail; } catch {}
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      return { key, value: JSON.stringify(data), shared: true };
    }

    if (key === "doc-resolve") {
      const payload = JSON.parse(value);
      const { data, error } = await supabase.rpc("resolve_doc_proposals", { payload });
      if (error) throw error;
      return { key, value: JSON.stringify(data), shared: true };
    }

    if (key === "tc-import") {
      // ceo import ide kroz jednu Postgres funkciju = jedna transakcija.
      // Ako bilo koji red padne, baza ostaje netaknuta.
      const { suites: newSuites = [], cases = [] } = JSON.parse(value);

      const payload = {
        suites: newSuites.map((s, i) => ({
          id: s.id,
          name: s.name,
          position: s.position ?? i,
        })),
        // caseToRow vec radi camelCase -> snake_case i cisti imageUrl iz koraka;
        // position racuna RPC, pa ga ne saljemo
        cases: cases.map((c) => {
          const row = caseToRow(c);
          delete row.position;
          return row;
        }),
      };

      const { data, error } = await supabase.rpc("import_test_cases", { payload });
      if (error) throw error;

      // da sledeca promena statusa ispravno upise red u istoriju
      (data?.cases || []).forEach((r) => lastStatus.set(r.id, r.status));

      return { key, value: JSON.stringify(data), shared: true };
    }

    if (key === "tc-positions") {
      // drag&drop: azurira samo suite_id + position za pogodjene TC-ove
      const rows = JSON.parse(value);
      for (const r of rows) {
        const { error } = await supabase.from("test_cases")
          .update({ suite_id: r.suiteId, position: r.position })
          .eq("id", r.id);
        if (error) throw error;
      }
      return { key, value, shared: true };
    }

    if (key === "tc-meta") {
      // sinhronizuje SAMO suites; slucajevi se upisuju preko tc-case-{id}
      const meta = JSON.parse(value);
      const incoming = (meta.suites || []).map((s, i) => ({
        id: s.id,
        name: s.name,
        position: i,
      }));
      const { data: existing, error: e1 } = await supabase.from("suites").select("id");
      if (e1) throw e1;
      const incomingIds = new Set(incoming.map((s) => s.id));
      const toDelete = (existing || []).filter((s) => !incomingIds.has(s.id)).map((s) => s.id);

      if (incoming.length > 0) {
        const { error } = await supabase.from("suites").upsert(incoming, { onConflict: "id" });
        if (error) throw error;
      }
      if (toDelete.length > 0) {
        // cascade brise i test_cases i status_history tih suite-ova
        const { error } = await supabase.from("suites").delete().in("id", toDelete);
        if (error) throw error;
      }
      return { key, value, shared: true };
    }

    if (key.startsWith("tc-case-")) {
      const c = JSON.parse(value);
      const { error } = await supabase.from("test_cases").upsert(caseToRow(c), { onConflict: "id" });
      if (error) throw error;

      // status se promenio (ili je slucaj nov) -> jedan red u istoriju
      const prev = lastStatus.get(c.id);
      if (prev !== c.status) {
        const latest = (c.history && c.history[0]) || {};
        const { error: e2 } = await supabase.from("status_history").insert({
          test_case_id: c.id,
          status: c.status,
          changed_by_name: latest.by || null,
          changed_at: latest.at || new Date().toISOString(),
          task: latest.task || null,
        });
        if (e2) throw e2;
        lastStatus.set(c.id, c.status);
      }
      return { key, value, shared: true };
    }

    throw new Error("Unsupported key: " + key);
  },

  async delete(key) {
    if (key === "tc-cases-all") {
      // SVI TC-ovi + SVA istorija, u stranicama (Supabase vraca max 1000 redova/upitu)
      const pageAll = async (table, cols, order) => {
        const PAGE = 1000;
        let out = [], from = 0;
        for (;;) {
          let q = supabase.from(table).select(cols).range(from, from + PAGE - 1);
          if (order) q = q.order(order.col, { ascending: order.asc });
          const { data, error } = await q;
          if (error) throw error;
          out = out.concat(data || []);
          if (!data || data.length < PAGE) break;
          from += PAGE;
        }
        return out;
      };
      const _t0 = performance.now();
      const [rows, hist] = await Promise.all([
        pageAll("test_cases", "*", null),
        pageAll("status_history", "test_case_id,status,changed_by_name,changed_at,task",
                { col: "changed_at", asc: false }),
      ]);
      console.log(`[perf] DB upiti (${(rows||[]).length} TC, ${(hist||[]).length} istorija): ${Math.round(performance.now()-_t0)}ms`);
      // grupisi istoriju po TC-u (vec sortirana najnovije-prvo), max 20 po TC-u
      const histByCase = new Map();
      for (const h of hist || []) {
        const arr = histByCase.get(h.test_case_id) || [];
        if (arr.length < 20) { arr.push(h); histByCase.set(h.test_case_id, arr); }
      }
      (rows || []).forEach((r) => lastStatus.set(r.id, r.status));
      const _t1 = performance.now();
      const cases = await withSignedUrlsBatch(
        (rows || []).map((r) => rowToCase(r, histByCase.get(r.id) || []))
      );
      console.log(`[perf] potpisivanje slika: ${Math.round(performance.now()-_t1)}ms`);
      const map = Object.fromEntries(cases.map((c) => [c.id, c]));
      return { key, value: JSON.stringify(map), shared: true };
    }

    if (key.startsWith("tc-case-")) {
      const id = key.slice("tc-case-".length);
      // pre brisanja reda, pokupi i obrisi njegove slike iz bucketa
      const { data: row } = await supabase.from("test_cases").select("steps,actual_result_images").eq("id", id).maybeSingle();
      const paths = [...(row?.steps || []).map((s) => s.image), ...(row?.actual_result_images || [])]
        .filter((p) => p && !p.startsWith("data:"));
      if (paths.length > 0) {
        const { error: eImg } = await supabase.storage.from(BUCKET).remove(paths);
        if (eImg) console.error("Brisanje screenshotova nije uspelo:", eImg);
      }
      const { error } = await supabase.from("test_cases").delete().eq("id", id);
      if (error) throw error;
      lastStatus.delete(id);
    }
    return { key, deleted: true, shared: true };
  },

  async list(prefix = "") {
    const { data } = await supabase.from("test_cases").select("id");
    const keys = (data || []).map((r) => "tc-case-" + r.id).filter((k) => k.startsWith(prefix));
    return { keys, prefix, shared: true };
  },
};
