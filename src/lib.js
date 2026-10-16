// ---------- deljene konstante i helperi (koristi ih i QATestCaseTool.jsx i ImportModal.jsx) ----------

export const STATUSES = {
  created:      { label: "Created",      dot: "bg-sky-500", chip: "bg-sky-50 text-sky-700 border-sky-200" },
  not_executed: { label: "Not executed", dot: "bg-slate-300", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  pass:         { label: "Pass",         dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  fail:         { label: "Fail",         dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  review:       { label: "Needs review", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  blocked:      { label: "Blocked",      dot: "bg-slate-700", chip: "bg-slate-800 text-slate-100 border-slate-700" },
};

// prioritet i tip test slucaja
export const PRIORITIES = {
  core:   { label: "Core",   chip: "bg-rose-50 text-rose-700 border-rose-200" },
  medium: { label: "Medium", chip: "bg-slate-100 text-slate-600 border-slate-200" },
  edge:   { label: "Edge",   chip: "bg-sky-50 text-sky-700 border-sky-200" },
};
export const CASE_TYPES = {
  positive: { label: "Positive", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  negative: { label: "Negative", chip: "bg-amber-50 text-amber-700 border-amber-200" },
};

export const STATUS_KEYS = Object.keys(STATUSES);
export const PRIORITY_KEYS = Object.keys(PRIORITIES);
export const CASE_TYPE_KEYS = Object.keys(CASE_TYPES);

// Osnova linka ka Jiri - npr. "https://jira.firma.rs/browse/" ili
// "https://firma.atlassian.net/browse/". Prazno = task ostaje obican tekst.
export const JIRA_BROWSE_URL = "https://polovnjaci.atlassian.net/browse/";

export const ENVIRONMENTS = ["Chrome", "Firefox", "Safari", "Edge", "iPhone", "Android", "Tablet", "API"];

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}. ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// resize pasted/uploaded screenshots so storage stays small
export const resizeImage = (file) =>
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

// selektovan tekst + nalepljen URL -> [selektovano](url); vraca novi sadrzaj ili null
export function smartLink(e) {
  const url = (e.clipboardData?.getData("text") || "").trim();
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  const el = e.target;
  const { selectionStart: s, selectionEnd: en, value } = el;
  if (s == null || s === en) return null; // nema selekcije -> obicno lepljenje
  return value.slice(0, s) + "[" + value.slice(s, en) + "](" + url + ")" + value.slice(en);
}
