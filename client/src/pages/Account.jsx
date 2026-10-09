import * as api from "../api.js";
import { ChevronRight, Copy, KeyRound, Loader2, Lock, LogOut, UserCog, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Chip, PrimaryButton, SectionLabel, TextField } from "../ui/common.jsx";
import { C, inputStyle } from "../ui/theme.js";

/* ------------------------------------------------------------------ */
/*  v3.0 — Account: Sleeper access (token, allow changes)               */
/* ------------------------------------------------------------------ */
function SleeperAccessPanel() {
  const [st, setSt] = useState(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api.getPrivateStatus().then(setSt).catch((e) => setMsg(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (fn, okMsg) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      setToken("");
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2.5" data-sleeper-access>
      <div style={{ color: C.textMuted }} className="text-xs">
        Optional. Lets the app read your trade offers and league settings log, and — only if you switch it on — push lineup changes, reject trades and enter waiver claims. It uses Sleeper's private, undocumented API with your login token. That API can change without notice and Sleeper's terms arguably restrict automation, so it's off until you turn it on. The token is stored encrypted on your server and never sent back to the browser.
      </div>
      {!st ? (
        <div style={{ color: C.textMuted }} className="text-xs">Loading…</div>
      ) : st.configured ? (
        <>
          <div style={{ color: C.ok }} className="text-xs">Connected{st.sleeperUsername ? ` as ${st.sleeperUsername}` : ""}{st.verifiedAt ? ` · verified ${new Date(st.verifiedAt).toLocaleDateString()}` : ""}.</div>
          {[
            ["reads", "Read from Sleeper", "Trade offers, queued waiver claims and the League change log. Off = none of these are fetched or shown."],
            ["roster", "Roster changes", "Push lineup changes and IR moves."],
            ["claims", "Waiver claims", "Submit and cancel waiver claims."],
            ["trades", "Trades", "Reject incoming offers and withdraw your own."],
          ].map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-sm" style={{ color: C.text }}>
              <input type="checkbox" checked={Boolean(st.perms?.[key])} disabled={busy} onChange={(e) => act(() => api.setPrivatePerms({ [key]: e.target.checked }))} className="mt-1" data-perm={key} />
              <span>{label}<span style={{ color: C.textMuted }} className="block text-xs">{hint}{key !== "reads" ? " Every push still shows exactly what it will send and asks you to confirm." : ""}</span></span>
            </label>
          ))}
          <button type="button" disabled={busy} onClick={() => act(() => api.clearPrivateToken(), "Token removed.")} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-remove-token>Remove token</button>
          {st.log?.length > 0 && (
            <div>
              <div style={{ color: C.textFaint }} className="text-[11px] pb-1">Recent changes sent to Sleeper</div>
              {st.log.slice(0, 8).map((l, i) => (
                <div key={i} style={{ color: l.ok ? C.textMuted : C.major }} className="text-[11px]">{new Date(l.at).toLocaleString()} · {l.action.replace(/_/g, " ")} · {l.ok ? "ok" : "failed"}{l.detail ? ` — ${l.detail}` : ""}</div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ color: C.textMuted }} className="text-xs">In Sleeper's website, open the browser's developer tools → Application → Local storage → sleeper.com → <code>token</code>, and paste its value here.</div>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Sleeper token" autoComplete="off" style={inputStyle} className="w-full rounded px-2 py-1.5 text-sm outline-none" aria-label="Sleeper token" data-token-input />
          <button type="button" disabled={busy || token.trim().length < 20} onClick={() => act(() => api.setPrivateToken(token), "Connected. Reading is on; every kind of change to Sleeper is still switched off.")} style={{ background: C.brand, color: C.text, opacity: busy || token.trim().length < 20 ? 0.5 : 1 }} className="rounded-md px-3 py-1.5 text-sm" data-save-token>Verify &amp; save</button>
        </>
      )}
      {msg && <div style={{ color: C.minor }} className="text-xs">{msg}</div>}
    </div>
  );
}

export function LoginScreen({ username, setUsername, password, setPassword, onSubmit, loading, error }) {
  const ready = username.trim() && password;
  return (
    <div className="px-5 py-8 flex flex-col items-center text-center gap-4">
      <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><Lock size={22} /></div>
      <div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg mb-1">Log in</div>
        <div style={{ color: C.textMuted }} className="text-sm max-w-xs">Use your Sleeper username and the password the owner of this app set up for you.</div>
      </div>
      <div className="w-full max-w-xs space-y-2.5">
        <TextField value={username} onChange={setUsername} placeholder="Sleeper username" autoFocus autoComplete="username" onEnter={() => ready && !loading && onSubmit()} />
        <TextField type="password" value={password} onChange={setPassword} placeholder="Password" autoComplete="current-password" onEnter={() => ready && !loading && onSubmit()} />
      </div>
      {error && <div style={{ color: C.major }} className="text-xs max-w-xs">{error}</div>}
      <div className="w-full max-w-xs">
        <PrimaryButton onClick={onSubmit} disabled={!ready} loading={loading} Icon={Lock}>{loading ? "Logging in…" : "Log in"}</PrimaryButton>
      </div>
    </div>
  );
}

// Used for both the forced first-login change and the voluntary one from the Account screen.
function ChangePasswordForm({ forced, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) return setError("New password must be at least 8 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      if (onDone) onDone();
    } catch (err) {
      setError(err.message || "Couldn't change the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {forced && (
        <div style={{ color: C.textMuted }} className="text-sm">
          You're signed in with a temporary password. Choose your own to continue — enter the temporary one as your current password.
        </div>
      )}
      <TextField type="password" value={current} onChange={setCurrent} placeholder="Current password" autoComplete="current-password" />
      <TextField type="password" value={next} onChange={setNext} placeholder="New password (8+ characters)" autoComplete="new-password" />
      <TextField type="password" value={confirm} onChange={setConfirm} placeholder="Confirm new password" autoComplete="new-password" onEnter={() => current && next && confirm && !busy && submit()} />
      {error && <div style={{ color: C.major }} className="text-xs">{error}</div>}
      {done && !forced && <div style={{ color: C.ok }} className="text-xs">Password changed. Your other devices were signed out.</div>}
      <PrimaryButton onClick={submit} disabled={!current || !next || !confirm} loading={busy} Icon={KeyRound}>
        {busy ? "Saving…" : "Change password"}
      </PrimaryButton>
    </div>
  );
}

export function ForcePasswordScreen({ authUser, onDone, onLogout }) {
  return (
    <div className="px-5 py-8 flex flex-col gap-4 max-w-sm mx-auto">
      <div className="flex flex-col items-center text-center gap-3">
        <div style={{ background: C.surfaceRaised, color: C.brand }} className="p-3 rounded-full"><KeyRound size={22} /></div>
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 600 }} className="text-lg">Choose a new password</div>
        <div style={{ color: C.textMuted }} className="text-xs">Signed in as {authUser?.username}</div>
      </div>
      <ChangePasswordForm forced onDone={onDone} />
      <button onClick={onLogout} style={{ color: C.textMuted }} className="text-xs font-medium flex items-center justify-center gap-1 pt-1">
        <LogOut size={13} /> Log out
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v3.2 — CBS pick'em: account panel (login, pools, recipe, switches)  */
/* ------------------------------------------------------------------ */
const RECIPE_EXAMPLE = `{
  "login":  { "url": "", "method": "POST", "contentType": "form", "body": "email={{email}}&password={{password}}", "successIncludes": "" },
  "submit": { "url": "", "method": "POST", "contentType": "form", "body": "", "successIncludes": "" },
  "games":    { "url": "", "idRegex": "" },
  "readback": { "url": "", "pickRegex": "" },
  "teamMap": {}
}`;

function CbsPanel() {
  const [st, setSt] = useState(null);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [recipeText, setRecipeText] = useState("");
  const [poolsText, setPoolsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(
    () =>
      api.getCbsStatus().then((d) => {
        setSt(d);
        setRecipeText((t) => t || (d.recipe && Object.keys(d.recipe).some((k) => k !== "teamMap") ? JSON.stringify(d.recipe, null, 2) : ""));
        setPoolsText((t) => t || (d.pools || []).map((p) => `${d.engine === "native" ? `https://picks.cbssports.com/football/pickem/pools/${p.id}${p.entryId ? `?entryId=${p.entryId}` : ""}` : p.id} ${p.name === p.id ? "" : p.name}`.trim()).join("\n"));
      }).catch((e) => setMsg(e.message)),
    []
  );
  useEffect(() => {
    load();
  }, [load]);
  const act = async (fn, okMsg) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (okMsg) setMsg(typeof okMsg === "function" ? okMsg(r) : okMsg);
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const parsePools = () =>
    poolsText.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, ...rest] = l.split(/\s+/);
      const old = (st?.pools || []).find((p) => p.id === id || id.includes(p.id));
      return { id, url: id, name: rest.join(" ") || old?.name || id, enabled: old ? old.enabled : true, entryId: old?.entryId || null };
    });
  const savePools = () => act(() => api.saveCbsSettings({ pools: parsePools() }), "Pools saved.");
  const saveRecipe = () => {
    let r;
    try {
      r = JSON.parse(recipeText || "{}");
    } catch {
      return setMsg("The recipe isn't valid JSON.");
    }
    return act(() => api.saveCbsSettings({ recipe: r, pools: parsePools() }), "Recipe and pools saved.");
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3 space-y-2.5" data-cbs-panel>
      <div style={{ color: C.textMuted }} className="text-xs">
        Optional. Auto mode sends your Pick'em picks to your CBS pick'em pools about an hour before each kickoff slot, and switches itself off if you change a pick on CBS. CBS has no public API, so this signs in with your CBS email and password (stored encrypted on your server, never sent back to the browser) and uses the same requests CBS's own site makes. CBS's terms may not allow automation, it can stop working whenever CBS changes its site or blocks scripted sign-ins, and it has not yet been tried against the real CBS — use "Test login" first. It is off until you switch it on, and every push is logged.
      </div>
      {!st ? (
        <div style={{ color: C.textMuted }} className="text-xs">Loading…</div>
      ) : (
        <>
          {st.configured ? (
            <div style={{ color: C.ok }} className="text-xs">Login saved for {st.email}.</div>
          ) : (
            <div className="space-y-1.5">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="CBS email" autoComplete="off" style={inputStyle} className="w-full rounded-md px-2.5 py-1.5 text-xs" data-cbs-email />
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="CBS password" autoComplete="new-password" style={inputStyle} className="w-full rounded-md px-2.5 py-1.5 text-xs" data-cbs-password />
              <button type="button" disabled={busy || !email || !pw} onClick={() => act(async () => { await api.saveCbsAccount(email, pw); setPw(""); }, "Login saved (encrypted).")} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-account>Save login</button>
            </div>
          )}
          {st.configured && (
            <>
              <label className="flex flex-col gap-0.5 text-xs" style={{ color: C.textMuted }}>
                {st.engine === "native" ? "Pools (one per line: paste the address of the pool's picks page from your browser — it contains /pools/… and ?entryId=… — then an optional name)" : "Pools (one per line: pool id, then an optional name)"}
                <textarea value={poolsText} onChange={(e) => setPoolsText(e.target.value)} rows={3} style={inputStyle} className="rounded-md px-2.5 py-1.5 text-xs font-mono" data-cbs-pools />
              </label>
              {st.engine === "recipe" && (
                <label className="flex flex-col gap-0.5 text-xs" style={{ color: C.textMuted }}>
                  Request recipe (JSON from your captured requests)
                  <textarea value={recipeText} onChange={(e) => setRecipeText(e.target.value)} rows={9} placeholder={RECIPE_EXAMPLE} style={inputStyle} className="rounded-md px-2.5 py-1.5 text-[11px] font-mono" data-cbs-recipe />
                </label>
              )}
              <div className="flex gap-2 flex-wrap">
                {st.engine === "recipe" ? (
                  <button type="button" disabled={busy} onClick={saveRecipe} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-recipe>Save recipe &amp; pools</button>
                ) : (
                  <button type="button" disabled={busy} onClick={savePools} style={{ background: C.brand, color: "#fff" }} className="rounded-md px-3 py-1.5 text-xs font-medium" data-cbs-save-pools>Save pools</button>
                )}
                <button type="button" disabled={busy || !st.recipeReady} onClick={() => act(() => api.testCbsLogin(), (r) => `${r.ok ? "" : "Login test failed: "}${r.detail}${r.cookieNames?.length ? ` Cookies received (names only): ${r.cookieNames.join(", ")}.` : ""}${r.warnings?.length ? ` Note: ${r.warnings.join(" ")}` : ""}`)} style={{ color: C.text, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-1.5 text-xs" data-cbs-login-test>Test login</button>
              </div>
              <label className="flex items-start gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.enabled} disabled={busy || !st.recipeReady || !(st.pools || []).length} onChange={(e) => act(() => api.saveCbsSettings({ enabled: e.target.checked }))} className="mt-1" data-cbs-enabled />
                <span>Auto mode<span style={{ color: C.textMuted }} className="block text-xs">Sends your picks about 60 minutes before each kickoff slot; never for a game that has started. Switches itself off if you change a pick on CBS (the app looks at CBS about every 30 minutes while auto mode is on). Needs at least one pool.</span></span>
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.paused} disabled={busy} onChange={(e) => act(() => api.saveCbsSettings({ paused: e.target.checked }))} data-cbs-paused />
                Pause (keeps your settings, sends nothing)
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: C.text }}>
                <input type="checkbox" checked={st.notify} disabled={busy} onChange={(e) => act(() => api.saveCbsSettings({ notify: e.target.checked }))} data-cbs-notify />
                Notify me after every push (success or failure)
              </label>
              {st.alert && (
                <div style={{ color: C.minor, border: `1px solid ${C.minor}55` }} className="rounded-md px-2.5 py-1.5 text-xs" data-cbs-alert>{st.alert.detail}</div>
              )}
              {st.engine === "native" && (
                <details className="text-xs" style={{ color: C.textMuted }}>
                  <summary className="cursor-pointer">Advanced: values copied from CBS's site</summary>
                  <div className="space-y-1.5 pt-1.5">
                    <div>If CBS changes its site these may need updating. The sign-in id is re-discovered automatically when it stops working.</div>
                    <div className="font-mono text-[10px] break-all">sign-in id: {st.native?.nextActionId}</div>
                    <div className="font-mono text-[10px] break-all">picks-page query: {st.native?.picksPageHash}</div>
                    <div className="font-mono text-[10px] break-all">save query: {st.native?.saveHash}</div>
                    <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ engine: "recipe" }), "Switched to the older request-recipe mode.")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-2.5 py-1 text-xs">Use the older request-recipe mode instead</button>
                  </div>
                </details>
              )}
              {st.engine === "recipe" && (
                <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ engine: "native" }), "Switched back to the built-in CBS mode.")} style={{ color: C.textMuted, border: `1px solid ${C.border}` }} className="rounded-md px-2.5 py-1 text-xs">Use the built-in CBS mode</button>
              )}
              {!st.verifiedOnce && (st.pools || []).length > 0 && (
                <div style={{ color: C.minor }} className="text-xs" data-cbs-testonly>
                  First run: only the first pool ({(st.pools.find((p) => p.id === st.testPoolId) || st.pools[0]).name}) is used until a push is read back from CBS{st.hasReadback ? "" : " (no read-back is set up, so check that pool on CBS yourself)"}.{" "}
                  <button type="button" disabled={busy} onClick={() => act(() => api.saveCbsSettings({ verifiedOnce: true }), "All pools will be used from now on.")} style={{ color: C.brand }} className="underline" data-cbs-trust>I checked it — use all pools</button>
                </div>
              )}
              <button type="button" disabled={busy} onClick={() => act(() => api.clearCbsAccount(), "CBS login removed and auto-push switched off.")} style={{ color: C.major, border: `1px solid ${C.major}66` }} className="rounded-md px-2.5 py-1 text-xs" data-cbs-remove>Remove CBS login</button>
              {(st.log || []).length > 0 && (
                <div data-cbs-log>
                  <div style={{ color: C.textFaint }} className="text-[10px] uppercase tracking-wide mb-1">Recent pushes</div>
                  <div className="space-y-1">
                    {st.log.slice(0, 12).map((r) => (
                      <div key={r.id} style={{ color: r.ok ? C.textMuted : C.major }} className="text-[11px]">
                        {new Date(r.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · {r.mode}{r.poolId ? ` · pool ${r.poolId}` : ""} · {r.ok ? "ok" : "FAILED"} — {r.detail}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
      {msg && <div style={{ color: C.textMuted }} className="text-xs" data-cbs-msg>{msg}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v4.3 — AI sources: what each Gemini feature read, preferred / removed */
/* ------------------------------------------------------------------ */
function AiSourcesPanel({ isOwner }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [draft, setDraft] = useState({});
  useEffect(() => {
    api.getAiSources().then(setData).catch((e) => setErr(e.message));
  }, []);
  const act = async (feature, action, source) => {
    setErr(null);
    try {
      setData(await api.updateAiSource(feature, action, source));
      if (action === "add") setDraft((d) => ({ ...d, [feature]: "" }));
    } catch (e) {
      setErr(e.message);
    }
  };
  if (!data) return <div style={{ color: err ? C.major : C.textMuted }} className="text-xs px-1">{err || "Loading…"}</div>;
  const pill = (text, color, onX, xLabel, key) => (
    <span key={key || text} style={{ border: `1px solid ${color}55`, color }} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]">
      {text}
      {onX && isOwner && (
        <button type="button" onClick={onX} aria-label={xLabel} title={xLabel} style={{ color: C.textMuted }} className="leading-none">×</button>
      )}
    </span>
  );
  return (
    <div className="space-y-2" data-ai-sources>
      <div style={{ color: C.textMuted }} className="text-xs px-1 leading-snug">
        The web sources behind each AI (Gemini) feature. Added sources are named to the AI as the ones to start with; removed ones are named as not to use and are also filtered out of every result. Google Search grounding can't be locked to a list of sites, so an added source is a strong hint, not a guarantee.{!data.configured ? " No Gemini key is set (GEMINI_API_KEY), so nothing runs yet." : ""}
      </div>
      {err && <div style={{ color: C.major }} className="text-xs px-1">{err}</div>}
      {data.features.map((f) => {
        const isOpen = open === f.key;
        const removedSet = (name) => f.removed.some((r) => r.toLowerCase() === name.toLowerCase());
        return (
          <div key={f.key} style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3 py-2.5" data-ai-feature={f.key}>
            <button type="button" onClick={() => setOpen(isOpen ? null : f.key)} className="w-full flex items-center justify-between gap-2 text-left" aria-expanded={isOpen}>
              <span style={{ color: C.text }} className="text-sm">{f.label}</span>
              <span style={{ color: C.textFaint }} className="text-[11px] shrink-0">
                {f.counts.length} seen · +{f.added.length} · −{f.removed.length} <ChevronRight size={13} className="inline" style={{ transform: isOpen ? "rotate(90deg)" : "none" }} />
              </span>
            </button>
            {isOpen && (
              <div className="mt-2 space-y-2 text-xs">
                <div>
                  <div style={{ color: C.textMuted }} className="mb-1">Used most {f.lastAt ? `(last run ${new Date(f.lastAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})` : "(no run yet)"}</div>
                  <div className="flex flex-wrap gap-1" data-ai-seen>
                    {f.counts.length === 0 && <span style={{ color: C.textFaint }}>Nothing yet.</span>}
                    {f.counts.filter((x) => !removedSet(x.name)).map((x) => pill(`${x.name} · ${x.n}`, C.text, () => act(f.key, "remove", x.name), `Remove ${x.name}`, x.name))}
                  </div>
                </div>
                <div>
                  <div style={{ color: C.textMuted }} className="mb-1">Added (preferred)</div>
                  <div className="flex flex-wrap gap-1" data-ai-added>
                    {f.added.length === 0 && <span style={{ color: C.textFaint }}>None.</span>}
                    {f.added.map((x) => pill(x, C.ok, () => act(f.key, "unadd", x), `Stop preferring ${x}`))}
                  </div>
                  {isOwner && (
                    <div className="flex gap-1.5 mt-1.5">
                      <input value={draft[f.key] || ""} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && act(f.key, "add", draft[f.key])} placeholder="Add a site or account, e.g. fantasypros.com" style={inputStyle} className="flex-1 rounded px-2 py-1 text-xs outline-none" data-ai-add-input />
                      <button type="button" onClick={() => act(f.key, "add", draft[f.key])} style={{ color: C.brand, border: `1px solid ${C.brand}66` }} className="rounded px-2 text-xs" data-ai-add>Add</button>
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ color: C.textMuted }} className="mb-1">Removed (not used, filtered out)</div>
                  <div className="flex flex-wrap gap-1" data-ai-removed>
                    {f.removed.length === 0 && <span style={{ color: C.textFaint }}>None.</span>}
                    {f.removed.map((x) => pill(x, C.major, () => act(f.key, "unremove", x), `Allow ${x} again`))}
                  </div>
                </div>
                {!f.perItem && <div style={{ color: C.textFaint }}>This feature's notes don't name a source per player, so a removed source is dropped from the source list and the next searches, not from notes already written.</div>}
                {!isOwner && <div style={{ color: C.textFaint }}>Only the owner can change sources.</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  v4.4.1 — API call presets (app-wide; the owner switches them)       */
/* ------------------------------------------------------------------ */
function ApiPresetsPanel({ isOwner }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [showList, setShowList] = useState(false);
  useEffect(() => {
    api.getApiPresets().then(setData).catch((e) => setErr(e.message));
  }, []);
  const pick = async (key) => {
    setErr(null);
    try { setData(await api.setApiPreset(key)); } catch (e) { setErr(e.message); }
  };
  if (!data || !Array.isArray(data.presets)) return <div style={{ color: err ? C.major : C.textMuted }} className="text-xs px-1">{err || "Loading…"}</div>;
  return (
    <div className="space-y-2" data-api-presets>
      <div style={{ color: C.textMuted }} className="text-xs px-1 leading-snug">
        How often the app asks Sleeper and the other data sources for fresh data. The setting is for everyone who uses this app; only the owner changes it.
      </div>
      {err && <div style={{ color: C.major }} className="text-xs px-1">{err}</div>}
      {data.presets.map((p) => {
        const on = data.active === p.key;
        return (
          <label key={p.key} style={{ background: C.surface, border: `1px solid ${on ? C.brand : C.border}` }} className="flex items-start gap-2.5 rounded-md px-3 py-2.5" data-api-preset={p.key}>
            <input type="radio" name="api-preset" checked={on} disabled={!isOwner} onChange={() => pick(p.key)} className="mt-1" />
            <span className="min-w-0">
              <span style={{ color: C.text }} className="text-sm">{p.label}{p.key === data.default ? " (default)" : ""}</span>
              <span style={{ color: C.textMuted }} className="block text-xs leading-snug mt-0.5">{p.summary}</span>
            </span>
          </label>
        );
      })}
      {!isOwner && <div style={{ color: C.textFaint }} className="text-xs px-1">Only the owner can change this.</div>}
      <button type="button" onClick={() => setShowList((v) => !v)} style={{ color: C.brand }} className="text-xs px-1" data-api-baseline-toggle>{showList ? "Hide" : "Show"} what Minimal includes</button>
      {showList && (
        <ul style={{ color: C.textMuted }} className="text-xs leading-snug list-disc pl-6 space-y-1" data-api-baseline>
          {(data.baseline || []).map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
    </div>
  );
}

export function AccountScreen({ authUser, onOpenAdmin, onLogout }) {
  return (
    <div className="px-4 py-3 space-y-4">
      <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-md px-3.5 py-3">
        <div style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{authUser?.username}</div>
        <div style={{ color: C.textMuted }} className="text-xs mt-0.5">{authUser?.role === "owner" ? "Owner" : "Guest"}</div>
      </div>
      <div>
        <SectionLabel>Sleeper access (optional)</SectionLabel>
        <div className="pt-1.5"><SleeperAccessPanel /></div>
      </div>
      <div>
        <SectionLabel>CBS pick'em push (optional)</SectionLabel>
        <div className="pt-1.5"><CbsPanel /></div>
      </div>
      <div>
        <SectionLabel>API call presets</SectionLabel>
        <div className="pt-1.5"><ApiPresetsPanel isOwner={authUser?.role === "owner"} /></div>
      </div>
      <div>
        <SectionLabel>AI sources</SectionLabel>
        <div className="pt-1.5"><AiSourcesPanel isOwner={authUser?.role === "owner"} /></div>
      </div>
      <div>
        <SectionLabel>Change password</SectionLabel>
        <div className="pt-1.5"><ChangePasswordForm /></div>
      </div>
      {authUser?.role === "owner" && (
        <button onClick={onOpenAdmin} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }} className="w-full rounded-md px-3.5 py-3 text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2"><UserCog size={16} style={{ color: C.brand }} /> Manage users</span>
          <ChevronRight size={16} style={{ color: C.textFaint }} />
        </button>
      )}
      <button onClick={onLogout} style={{ color: C.textMuted }} className="text-xs font-medium flex items-center gap-1 px-1">
        <LogOut size={13} /> Log out
      </button>
    </div>
  );
}

export function AdminScreen({ authUser }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { username, password, verb }
  const [busyKey, setBusyKey] = useState(null);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("guest");
  const [newPassword, setNewPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { users: list } = await api.adminListUsers();
      setUsers(list);
    } catch (err) {
      setError(err.message || "Couldn't load users.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, fn) => {
    setBusyKey(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err.message || "That didn't work.");
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const add = async () => {
    const res = await run("add", () => api.adminCreateUser(newName.trim(), newRole, newPassword));
    if (res) {
      setNotice({ username: res.user.username, password: res.temporaryPassword, verb: "created" });
      setNewName("");
      setNewPassword("");
      setNewRole("guest");
      load();
    }
  };
  const reset = async (u) => {
    const res = await run(`reset:${u.username}`, () => api.adminResetPassword(u.username));
    if (res) {
      setNotice({ username: u.username, password: res.temporaryPassword, verb: "reset" });
      load();
    }
  };
  const setRole = async (u, role) => {
    if (await run(`role:${u.username}`, () => api.adminSetRole(u.username, role))) load();
  };
  const setAccess = async (u, active) => {
    if (await run(`access:${u.username}`, () => api.adminSetAccess(u.username, active))) load();
  };
  const remove = async (u) => {
    if (await run(`rm:${u.username}`, () => api.adminDeleteUser(u.username))) {
      setConfirmRemove(null);
      load();
    }
  };
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked on plain HTTP; the password is shown on screen to copy by hand.
    }
  };

  const small = { border: `1px solid ${C.border}`, color: C.textMuted };

  return (
    <div className="px-4 py-3 space-y-4">
      {notice && (
        <div style={{ background: C.surface, border: `1px solid ${C.brand}` }} className="rounded-md px-3.5 py-3 space-y-1.5">
          <div style={{ color: C.text }} className="text-xs">
            Temporary password for <b>{notice.username}</b> ({notice.verb}). Share it with them now — it isn't shown again. They must change it at first login.
          </div>
          <div className="flex items-center gap-2">
            <code style={{ background: C.bg, color: C.brand }} className="text-sm rounded px-2 py-1 select-all break-all">{notice.password}</code>
            <button onClick={() => copy(notice.password)} style={small} className="text-[11px] rounded-full px-2 py-1 flex items-center gap-1 shrink-0">
              <Copy size={11} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setNotice(null)} style={{ color: C.textFaint }} className="text-[11px]">Dismiss</button>
        </div>
      )}
      {error && <div style={{ color: C.major }} className="text-xs px-1">{error}</div>}

      <div>
        <SectionLabel>Users</SectionLabel>
        {!users && !error && <div className="flex items-center gap-2 px-1 py-3" style={{ color: C.textMuted }}><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading…</span></div>}
        <div className="space-y-2">
          {(users || []).map((u) => {
            const self = u.username === authUser?.username;
            const locked = u.isEnvOwner;
            return (
              <div key={u.username} style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: u.active ? 1 : 0.7 }} className="rounded-md px-3.5 py-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ color: C.text, fontFamily: "Oswald, sans-serif", fontWeight: 500 }} className="text-sm">{u.username}</span>
                  <Chip color={u.role === "owner" ? C.brand : C.textMuted}>{u.role}</Chip>
                  {!u.active && <Chip color={C.major}>revoked</Chip>}
                  {u.mustChangePassword && <Chip color={C.minor}>temp password</Chip>}
                  {self && <Chip color={C.textFaint}>you</Chip>}
                </div>
                <div style={{ color: C.textFaint }} className="text-[11px]">
                  {u.lastLoginAt ? `Last login ${new Date(u.lastLoginAt).toLocaleString()}` : "Never logged in"}
                  {locked ? " · set by OWNER_USERNAME" : ""}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={() => reset(u)} disabled={busyKey === `reset:${u.username}`} style={small} className="text-[11px] rounded-full px-2.5 py-1 flex items-center gap-1">
                    <KeyRound size={11} /> Reset password
                  </button>
                  {!locked && !self && (
                    <>
                      <button onClick={() => setRole(u, u.role === "owner" ? "guest" : "owner")} disabled={busyKey === `role:${u.username}`} style={small} className="text-[11px] rounded-full px-2.5 py-1">
                        {u.role === "owner" ? "Make guest" : "Make owner"}
                      </button>
                      <button onClick={() => setAccess(u, !u.active)} disabled={busyKey === `access:${u.username}`} style={{ ...small, color: u.active ? C.major : C.ok }} className="text-[11px] rounded-full px-2.5 py-1">
                        {u.active ? "Revoke access" : "Restore access"}
                      </button>
                      {confirmRemove === u.username ? (
                        <>
                          <button onClick={() => remove(u)} disabled={busyKey === `rm:${u.username}`} style={{ border: `1px solid ${C.major}`, color: C.major }} className="text-[11px] rounded-full px-2.5 py-1">Confirm remove</button>
                          <button onClick={() => setConfirmRemove(null)} style={small} className="text-[11px] rounded-full px-2.5 py-1">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmRemove(u.username)} style={small} className="text-[11px] rounded-full px-2.5 py-1">Remove</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <SectionLabel>Add a user</SectionLabel>
        <div className="space-y-2.5 pt-1.5">
          <TextField value={newName} onChange={setNewName} placeholder="Their Sleeper username" />
          <TextField value={newPassword} onChange={setNewPassword} placeholder="Temporary password (blank = generate one)" autoComplete="off" />
          <div className="flex items-center gap-2">
            {["guest", "owner"].map((r) => (
              <button key={r} onClick={() => setNewRole(r)} style={{ border: `1px solid ${newRole === r ? C.brand : C.border}`, color: newRole === r ? C.brand : C.textMuted }} className="text-xs rounded-full px-3 py-1 capitalize">{r}</button>
            ))}
          </div>
          <PrimaryButton onClick={add} disabled={!newName.trim()} loading={busyKey === "add"} Icon={UserPlus}>
            {busyKey === "add" ? "Adding…" : "Add user"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
