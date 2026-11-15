// v4.20.0 (P-48): "Ticker sync" — the only page a ticker account can open. Link the Sleeper account (the login name is the Sleeper
// username), choose which leagues feed the ticker, see sync status, and make or revoke read-only ticker tokens (scope ticker:read).
import { Copy, KeyRound, Loader2, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { Chip, SectionLabel, TextField } from "../ui/common.jsx";
import { C } from "../ui/theme.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

export function TickerSyncScreen({ authUser, onLogout }) {
  const [st, setSt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null); // { name, token } shown once
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.getTickerSync().then(setSt).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async (key, fn) => {
    setBusy(key); setError(null);
    try { const r = await fn(); if (r && r.leagues) setSt(r); return r; } catch (e) { setError(e.message || "That didn't work."); return null; } finally { setBusy(null); }
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* shown on screen to copy by hand */ } };
  const small = { border: `1px solid ${C.border}`, color: C.textMuted };

  const create = async () => {
    const r = await run("create", () => api.tickerSyncCreateToken(name.trim()));
    if (r?.created) { setFresh({ name: r.created.name, token: r.created.token }); setSt(r.status); setName(""); }
  };

  return (
    <div className="px-4 py-3 space-y-4" data-ticker-sync>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-base">Ticker sync</div>
          <div style={{ color: C.textMuted }} className="text-xs">Signed in as {authUser?.username}</div>
        </div>
        <button onClick={onLogout} style={small} className="text-[11px] rounded-full px-2.5 py-1 flex items-center gap-1"><LogOut size={11} /> Sign out</button>
      </div>
      {error && <div style={{ color: C.major }} className="text-xs px-1">{error}</div>}
      {!st && !error && <div className="flex items-center gap-2 px-1 py-3" style={{ color: C.textMuted }}><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading…</span></div>}

      {st && (
        <>
          <div>
            <SectionLabel>Sleeper account</SectionLabel>
            <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span style={{ color: C.text }} className="text-sm">{st.username}</span>
                <Chip color={st.linked ? C.ok : C.textFaint}>{st.linked ? "linked" : "unlinked"}</Chip>
              </div>
              <div style={{ color: C.textFaint }} className="text-[11px]">
                Your login name is your Sleeper username. Leagues last read {when(st.leaguesSyncedAt)} · scores last updated {when(st.lastSnapshotAt)}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button onClick={() => run("link", () => api.tickerSyncLink())} disabled={busy === "link"} style={small} className="text-[11px] rounded-full px-2.5 py-1 flex items-center gap-1">
                  <RefreshCw size={11} className={busy === "link" ? "animate-spin" : ""} /> {st.leagueCount === 0 || !st.leaguesSyncedAt ? "Link and read my leagues" : "Read my leagues again"}
                </button>
                {st.linked && (
                  <button onClick={() => run("unlink", () => api.tickerSyncUnlink())} disabled={busy === "unlink"} style={{ ...small, color: C.major }} className="text-[11px] rounded-full px-2.5 py-1">Unlink (stop syncing)</button>
                )}
              </div>
            </div>
          </div>

          <div>
            <SectionLabel>Leagues in the ticker</SectionLabel>
            <div className="space-y-1.5">
              {st.leagues.length === 0 && <div style={{ color: C.textMuted }} className="text-xs px-1">No leagues yet. Use "Link and read my leagues" above.</div>}
              {st.leagues.map((l) => (
                <label key={l.id} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-2.5 flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={l.includeInTicker} onChange={(e) => run(`lg:${l.id}`, () => api.tickerSyncLeagues({ [l.id]: e.target.checked }))} />
                  <span style={{ color: C.text }} className="text-sm flex-1">{l.name}</span>
                  <span style={{ color: C.textFaint }} className="text-[11px]">{l.includeInTicker ? "in ticker" : "left out"}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <SectionLabel>Ticker tokens (read-only)</SectionLabel>
            {fresh && (
              <div style={{ background: C.surface, border: `1px solid ${C.brand}` }} className="rounded-md px-3.5 py-3 space-y-1.5 mb-2">
                <div style={{ color: C.text }} className="text-xs">Token <b>{fresh.name}</b>: copy it now, it is not shown again.</div>
                <div className="flex items-center gap-2">
                  <code style={{ background: C.bg, color: C.brand }} className="text-xs rounded px-2 py-1 select-all break-all">{fresh.token}</code>
                  <button onClick={() => copy(fresh.token)} style={small} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0"><Copy size={11} /> {copied ? "Copied" : "Copy"}</button>
                </div>
                <button onClick={() => setFresh(null)} style={{ color: C.textFaint }} className="text-[11px]">Dismiss</button>
              </div>
            )}
            <div className="space-y-1.5">
              {st.tokens.map((t) => (
                <div key={t.id} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-2.5 flex items-center gap-2">
                  <KeyRound size={13} style={{ color: C.textMuted }} />
                  <div className="flex-1 min-w-0">
                    <div style={{ color: C.text }} className="text-sm truncate">{t.name} <span style={{ color: C.textFaint }}>…{t.last4}</span></div>
                    <div style={{ color: C.textFaint }} className="text-[11px]">{t.scope} · made {when(t.createdAt)} · last used {when(t.lastUsedAt)}</div>
                  </div>
                  <button onClick={() => run(`rv:${t.id}`, () => api.tickerSyncRevokeToken(t.id))} disabled={busy === `rv:${t.id}`} style={{ ...small, color: C.major }} className="text-[11px] rounded-full px-2.5 py-1 flex items-center gap-1"><Trash2 size={11} /> Revoke</button>
                </div>
              ))}
              {st.tokens.length === 0 && <div style={{ color: C.textMuted }} className="text-xs px-1">No tokens yet.</div>}
            </div>
            <div className="flex items-center gap-2 pt-2">
              <div className="flex-1"><TextField value={name} onChange={setName} placeholder="Token name (for example: Living room TV)" /></div>
              <button onClick={create} disabled={!name.trim() || busy === "create" || st.tokens.length >= st.maxTokens} style={{ border: `1px solid ${C.brand}`, color: C.brand }} className="text-xs rounded-full px-3 py-1.5">Create</button>
            </div>
            <div style={{ color: C.textFaint }} className="text-[11px] pt-1.5">
              A token can only read the ticker (scores, health, score events, headshots) for your own leagues. At most {st.maxTokens} tokens; {st.rateLimitPerMin} requests a minute each.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
