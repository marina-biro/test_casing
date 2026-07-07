// AuthGate.jsx - KORAK 4: login
// Obmotava aplikaciju: bez sesije prikazuje login formu,
// sa sesijom prikazuje tanku traku (ko je ulogovan + odjava) i aplikaciju.

import { useState, useEffect } from "react";
import { supabase } from "./storageShim.js";

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = jos proveravamo
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(
        error.message === "Invalid login credentials"
          ? "Pogrešan email ili lozinka."
          : error.message
      );
    }
    setBusy(false);
  };

  const signOut = () => supabase.auth.signOut();

  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-400 font-mono text-sm">
        Provera prijave…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <form onSubmit={signIn} className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
          <div className="flex items-baseline gap-2 mb-6">
            <span className="font-mono font-bold text-indigo-700 text-xl tracking-tight">TC/</span>
            <span className="font-semibold text-slate-900 text-lg">Test Case Tool</span>
          </div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Email</label>
          <input
            type="email" autoComplete="username" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-4 outline-none focus:border-indigo-400"
          />
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Lozinka</label>
          <input
            type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-4 outline-none focus:border-indigo-400"
          />
          {error && <p className="text-xs text-rose-600 mb-3">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg py-2.5 transition-colors">
            {busy ? "Prijavljivanje…" : "Prijavi se"}
          </button>
          <p className="mt-4 text-xs text-slate-400 text-center">
            Nemaš nalog? Javi se administratoru alata.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="bg-slate-900 text-slate-300 text-xs px-5 py-1.5 flex items-center gap-2">
        <span className="font-mono">{session.user.email}</span>
        <button onClick={signOut} className="ml-auto hover:text-white underline underline-offset-2">
          Odjavi se
        </button>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
