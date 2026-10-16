import { JIRA_BROWSE_URL } from "../lib.js";

// tekst sa kliktabilnim URL-ovima (za tabelu)
export function Linkified({ text }) {
  if (!text) return "—";
  const s = String(text);
  // [prikazani tekst](https://link) ili goli https://link
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/g;
  const out = [];
  let last = 0, m, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const label = m[1] || m[3];
    const href = m[2] || m[3];
    out.push(
      <a key={k++} href={href} target="_blank" rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-indigo-600 underline underline-offset-2 break-all hover:text-indigo-800">{label}</a>
    );
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// broj Jira taska kao link (ako je JIRA_BROWSE_URL podesen)
export function TaskLink({ task }) {
  if (!task) return "—";
  if (!JIRA_BROWSE_URL) return task;
  return (
    <a href={JIRA_BROWSE_URL + encodeURIComponent(task)} target="_blank" rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-indigo-600 underline underline-offset-2 hover:text-indigo-800">{task}</a>
  );
}
