import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";

export default function Lightbox({ src, onClose }) {
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
        onClick={(e) => { e.stopPropagation(); if (scale === 1) zoomTo(2.5); }}
        onMouseDown={onMouseDown}
        onDoubleClick={(e) => { e.stopPropagation(); zoomTo(scale > 1 ? 1 : 2.5); }}
        draggable={false}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
                 cursor: scale > 1 ? "grab" : "zoom-in",
                 transition: dragRef.current ? "none" : "transform 120ms" }}
        className="max-w-[92vw] max-h-[92vh] rounded-xl shadow-2xl select-none" />
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-800/90 rounded-full px-2 py-1.5"
        onClick={(e) => { e.stopPropagation(); if (scale === 1) zoomTo(2.5); }}>
        <button onClick={() => zoomTo(scale / 1.4)} className="text-slate-200 hover:text-white w-7 h-7 text-lg leading-none">−</button>
        <span className="text-slate-300 text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomTo(scale * 1.4)} className="text-slate-200 hover:text-white w-7 h-7 text-lg leading-none">+</button>
        <button onClick={() => zoomTo(1)} className="text-slate-300 hover:text-white text-xs px-2">Reset</button>
        <button onClick={onClose} className="text-slate-300 hover:text-white px-2"><X size={15} /></button>
      </div>
      <p className="absolute top-4 left-1/2 -translate-x-1/2 text-slate-400 text-xs">
        click or scroll = zoom · drag = pan · double-click = 100% · Esc = close
      </p>
    </div>
  );
}
