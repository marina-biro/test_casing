// storageShim.js - KORAK 2: Supabase implementacija
// Menja localStorage verziju. Isti window.storage API koji komponenta vec koristi,
// ali kljucevi se mapiraju na tabele u bazi:
//   tc-user      -> localStorage (ime po uredjaju; u koraku 4 dolazi iz logina)
//   tc-meta      -> tabela suites (+ lista slucajeva iz test_cases)
//   tc-case-{id} -> red u test_cases + redovi u status_history

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// pamti poslednji poznat status po slucaju, da bismo znali kada je
// promena statusa (i samo tada upisali red u status_history)
const lastStatus = new Map();

// ---------- mapiranje red <-> objekat koji komponenta ocekuje ----------
function rowToCase(row, historyRows) {
  const history = (historyRows || []).map((h) => ({
    status: h.status,
    by: h.changed_by_name,
    at: h.changed_at,
  }));
  const latest = history[0] || null;
  return {
    id: row.id,
    suiteId: row.suite_id,
    caseId: row.case_id,
    title: row.title || "",
    objective: row.objective || "",
    preconditions: row.preconditions || "",
    testData: row.test_data || "",
    postconditions: row.postconditions || "",
    environment: row.environment || [],
    notes: row.notes || "",
    actualResult: row.actual_result || "",
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
    preconditions: c.preconditions,
    test_data: c.testData,
    postconditions: c.postconditions,
    environment: c.environment || [],
    notes: c.notes,
    actual_result: c.actualResult,
    steps: c.steps || [],
    status: c.status,
    created_by_name: c.createdBy || null,
  };
}

// ---------- window.storage ----------
window.storage = {
  async get(key) {
    if (key === "tc-user") {
      const v = localStorage.getItem("qa-tc:user");
      if (v === null) throw new Error("Key not found: " + key);
      return { key, value: v, shared: true };
    }

    if (key === "tc-meta") {
      const [{ data: suites, error: e1 }, { data: cases, error: e2 }] =
        await Promise.all([
          supabase.from("suites").select("id,name").order("position").order("created_at"),
          supabase.from("test_cases").select("id,suite_id,case_id,title,status,environment"),
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
        })),
      };
      return { key, value: JSON.stringify(meta), shared: true };
    }

    if (key.startsWith("tc-case-")) {
      const id = key.slice("tc-case-".length);
      const [{ data: row, error: e1 }, { data: hist, error: e2 }] =
        await Promise.all([
          supabase.from("test_cases").select("*").eq("id", id).maybeSingle(),
          supabase.from("status_history").select("status,changed_by_name,changed_at")
            .eq("test_case_id", id).order("changed_at", { ascending: false }).limit(20),
        ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (!row) throw new Error("Key not found: " + key);
      lastStatus.set(row.id, row.status);
      return { key, value: JSON.stringify(rowToCase(row, hist)), shared: true };
    }

    throw new Error("Key not found: " + key);
  },

  async set(key, value) {
    if (key === "tc-user") {
      localStorage.setItem("qa-tc:user", value);
      return { key, value, shared: false };
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
        });
        if (e2) throw e2;
        lastStatus.set(c.id, c.status);
      }
      return { key, value, shared: true };
    }

    throw new Error("Unsupported key: " + key);
  },

  async delete(key) {
    if (key.startsWith("tc-case-")) {
      const id = key.slice("tc-case-".length);
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
