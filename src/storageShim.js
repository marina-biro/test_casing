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
  const arPath = c.actualResultImage && !c.actualResultImage.startsWith("data:") ? [c.actualResultImage] : [];
  const paths = [...stepPaths, ...arPath];
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
    actualResultImageUrl: arPath.length ? urlMap.get(c.actualResultImage) || null : null,
  };
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
    preconditions: row.preconditions || "",
    testData: row.test_data || "",
    postconditions: row.postconditions || "",
    environment: row.environment || [],
    notes: row.notes || "",
    actualResult: row.actual_result || "",
    task: row.task || null,
    actualResultImage: row.actual_result_image || null,
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
    task: c.task || null,
    actual_result_image: c.actualResultImage || null,
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
      const { data: { user } } = await supabase.auth.getUser();
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
    if (key.startsWith("tc-case-")) {
      const id = key.slice("tc-case-".length);
      // pre brisanja reda, pokupi i obrisi njegove slike iz bucketa
      const { data: row } = await supabase.from("test_cases").select("steps,actual_result_image").eq("id", id).maybeSingle();
      const paths = [...(row?.steps || []).map((s) => s.image), row?.actual_result_image]
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
