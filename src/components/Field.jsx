import { smartLink } from "../lib.js";

export default function Field({ label, hint, value, onChange, placeholder, onPaste, children, readOnly }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {label}
        {hint && <span className="normal-case font-normal tracking-normal text-slate-400"> — {hint}</span>}
      </p>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onPaste={(e) => {
          if (onPaste) onPaste(e);
          if (e.defaultPrevented || readOnly) return;
          const next = smartLink(e);
          if (next !== null) { e.preventDefault(); onChange(next); }
        }}
        readOnly={readOnly}
        className="w-full text-sm text-slate-800 bg-transparent outline-none resize-y placeholder-slate-400 placeholder:italic" />
      {children}
    </div>
  );
}
