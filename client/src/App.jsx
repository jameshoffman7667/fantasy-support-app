import * as api from "./api.js";
import { PAGE_LABEL, applyAcks, autoClearKeys, collectVariances } from "./variances.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountScreen, AdminScreen, ForcePasswordScreen, LoginScreen } from "./pages/Account.jsx";
import { AnalyticsScreen } from "./pages/Analytics.jsx";
import { CommishScreen } from "./pages/Commish.jsx"; // v3.8
import { Dashboard, LeagueOverview, SelectLeaguesScreen } from "./pages/Dashboard.jsx";
import { GameDayScreen } from "./pages/GameDay.jsx";
import { InjuryTab } from "./pages/InjuryPage.jsx";
import { LeaguePage } from "./pages/LeaguePage.jsx";
import { PickemScreen } from "./pages/Pickem.jsx";
import { RosterPage } from "./pages/RosterPage.jsx";
import { SeasonOutlookTab } from "./pages/SeasonOutlook.jsx";
import { TradeTab } from "./pages/TradePage.jsx";
import { WaiverTab } from "./pages/WaiverPage.jsx";
import { LeagueTabs, STATUS_BADGE_TABS, TAB_META, TabBar, TopBar, sourceStatusLabel } from "./ui/chrome.jsx";
import { BootstrapScreen, CardCtx, ErrorScreen } from "./ui/common.jsx";
import { computeInjury, computeLineup, computeRoster, computeTrade, computeWaiver } from "./ui/compute.js";
import { ClearVariancesButton, DvpDetailModal, VarianceButton, VarianceReportModal, WeatherModal } from "./ui/modals.jsx";
import { PlayerCardCtx, PlayerCardModal } from "./ui/playerCard.jsx";
import { C } from "./ui/theme.js";

const TAB_COMPONENTS = { roster: RosterPage, waiver: WaiverTab, trade: TradeTab, injury: InjuryTab, league: LeaguePage, odds: SeasonOutlookTab };

/* ------------------------------------------------------------------ */
/*  ROOT APP                                                           */
/* ------------------------------------------------------------------ */
const AUTO_REFRESH_MS = 30 * 60 * 1000;

const BUILD_CONCURRENCY = 2;

// Merge freshly built leagues into the list, keeping the tracked order.
function mergeLeagues(prev, incoming, order) {
  const byId = new Map(prev.map((l) => [l.id, l]));
  for (const l of incoming) byId.set(l.id, l);
  const ids = order && order.length ? order : [...byId.keys()];
  const rest = [...byId.keys()].filter((id) => !ids.includes(id));
  return [...ids, ...rest].map((id) => byId.get(id)).filter(Boolean);
}

export default function App() {
  const [view, setView] = useState({ screen: "bootstrapping" });
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState("just now");
  const [sourceStatus, setSourceStatus] = useState(null);
  // v2.7: red dot on the Pick'em tab when a recommendation changed before kickoff.
  const [pickemChanged, setPickemChanged] = useState(0);
  // v2.8: matchup-difficulty tables per scoring profile (colour the cards) and the card pop-ups.
  const [dvpTables, setDvpTables] = useState({});
  const [dvpVersion, setDvpVersion] = useState(0);
  const [modal, setModal] = useState(null);
  // v2.6: refresh the real source-status line whenever the "synced" time changes.
  useEffect(() => {
    api.getSourceStatus().then(setSourceStatus).catch(() => {});
  }, [syncedAt, refreshing]);

  const [authUser, setAuthUser] = useState(null);
  const [username, setUsername] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [sleeperUser, setSleeperUser] = useState(null);
  const [availableLeagues, setAvailableLeagues] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  const [liveLeagues, setLiveLeagues] = useState([]);
  const [week, setWeek] = useState(null);
  // v2.9: per-week copies of the last build, so switching weeks shows something instantly.
  const weekCache = useRef(new Map());
  const buildSeq = useRef(0);

  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);

  // Browser back/forward support: every real navigation pushes a history
  // entry carrying the view state; popstate restores it directly without
  // pushing again (that's what "going back" means — undoing the push).
  const navigate = useCallback((newView, opts = {}) => {
    setView(newView);
    if (opts.replace) window.history.replaceState(newView, "");
    else window.history.pushState(newView, "");
  }, []);

  useEffect(() => {
    const onPopState = (e) => setView(e.state || { screen: "dashboard" });
    window.addEventListener("popstate", onPopState);
    window.history.replaceState({ screen: "bootstrapping" }, "");
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const rawComputed = useMemo(
    () =>
      liveLeagues.map((lg) =>
        lg.error
          ? lg
          : {
              ...lg,
              roster: computeRoster(lg),
              lineup: computeLineup(lg),
              waiver: computeWaiver(lg, liveLeagues),
              trade: computeTrade(lg),
              injury: computeInjury(lg),
            }
      ),
    [liveLeagues]
  );
  // v2.8.1: cleared minor variances (per user, server-side) are applied on
  // top — they stop colouring rows, page badges and league cards.
  const [acks, setAcks] = useState(() => new Set());
  const computed = useMemo(() => rawComputed.map((lg) => applyAcks(lg, acks)), [rawComputed, acks]);

  const activeLeague = useMemo(() => computed.find((l) => l.id === (view.leagueId || null)), [computed, view.leagueId]);

  // v2.9: build leagues a couple at a time and show each as it arrives (the
  // last saved copy is already on screen, so nothing blocks on this). A newer
  // build supersedes an older one. Returns { week, superseded }; throws only if
  // not a single league could be built.
  const buildAll = useCallback(async (sid, ids, wk, { manual = false, opened = false } = {}) => {
    const seq = ++buildSeq.current;
    let builtWeek = wk;
    let ok = 0;
    let firstError = null;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const r = await api.buildLeagues(sid, [id], wk, ids, { manual, opened });
          if (seq !== buildSeq.current) return;
          builtWeek = r.week ?? builtWeek;
          if (r.leagues.some((l) => !l.error)) ok += 1;
          setLiveLeagues((prev) => {
            const next = mergeLeagues(prev, r.leagues, ids);
            weekCache.current.set(builtWeek, next.filter((l) => !l.error));
            return next;
          });
        } catch (err) {
          firstError = firstError || err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BUILD_CONCURRENCY, ids.length) }, worker));
    if (seq !== buildSeq.current) return { week: builtWeek, superseded: true };
    if (!ok && firstError) throw firstError;
    return { week: builtWeek, superseded: false };
  }, []);

  // Shared by both the bootstrap effect and the post-login handler: given
  // the server's last-session record (username + tracked leagues + week),
  // reconnect to Sleeper and refresh the dashboard. This is what replaces
  // localStorage — the record lives in SQLite, tied to the login, not the
  // browser, so it follows the person across devices.
  const reconnectFromLastSession = useCallback(
    async (last, { showedCache = false } = {}) => {
      try {
        const { sessionId, user, week: currentWeek, leagues } = await api.connect();
        setSessionId(sessionId);
        setSleeperUser(user);
        setAvailableLeagues(leagues);
        const validIds = leagues.map((l) => l.league_id);
        const restoredIds = (last?.leagueIds || []).filter((id) => validIds.includes(id));
        setSelectedIds(restoredIds.length ? restoredIds : validIds);
        setWeek((w) => w ?? currentWeek);
        if (restoredIds.length === 0) {
          navigate({ screen: "select" }, { replace: true });
          return;
        }
        if (!showedCache) setLoadingLeagues(true);
        setRefreshing(true);
        const { week: builtWeek } = await buildAll(sessionId, restoredIds, last?.week ?? undefined, { opened: true });
        setWeek(builtWeek ?? currentWeek);
        setSyncedAt("just now");
        if (!showedCache) navigate({ screen: "dashboard" }, { replace: true });
      } catch (err) {
        // Logged in fine, but Sleeper couldn't be reached. With saved data on screen, stay on it;
        // otherwise land on the league picker with the reason shown.
        setConnectError(err.message || "Couldn't reach Sleeper — try again.");
        if (!showedCache) navigate({ screen: "select" }, { replace: true });
      } finally {
        setLoadingLeagues(false);
        setRefreshing(false);
      }
    },
    [navigate, buildAll]
  );

  // After login/bootstrap: a pending forced password change blocks everything else.
  // v2.9: show the last saved build at once, then update it live in the background.
  const enterApp = useCallback(
    async (status) => {
      setAuthUser(status.user);
      if (status.user.mustChangePassword) {
        navigate({ screen: "forceChange" }, { replace: true });
        return;
      }
      let showedCache = false;
      try {
        const c = await api.getCachedLeagues();
        if (c.leagues?.length) {
          setLiveLeagues(c.leagues);
          setWeek(c.week ?? null);
          setSelectedIds(c.leagueIds || c.leagues.map((l) => l.id));
          setSyncedAt("saved copy");
          navigate({ screen: "dashboard" }, { replace: true });
          showedCache = true;
        }
      } catch {
        // No saved copy (or the call failed) — fall through to the normal path.
      }
      await reconnectFromLastSession(status.lastSession, { showedCache });
    },
    [navigate, reconnectFromLastSession]
  );

  useEffect(() => {
    (async () => {
      try {
        const status = await api.getAuthStatus();
        if (!status.authenticated) {
          navigate({ screen: "login" }, { replace: true });
          return;
        }
        await enterApp(status);
      } catch {
        navigate({ screen: "login" }, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server says the session is gone (logged out elsewhere, or the owner revoked access).
  useEffect(() => {
    const onUnauthorized = () => {
      setAuthUser(null);
      setSessionId(null);
      setLiveLeagues([]);
      setPassword("");
      setLoginError("Your session ended — please log in again.");
      setView((v) => (v.screen === "login" ? v : { screen: "login" }));
      window.history.replaceState({ screen: "login" }, "");
    };
    window.addEventListener("fm-unauthorized", onUnauthorized);
    return () => window.removeEventListener("fm-unauthorized", onUnauthorized);
  }, []);

  const handleLoginSubmit = useCallback(async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      await api.login(username.trim(), password);
      setPassword("");
      const status = await api.getAuthStatus();
      await enterApp(status);
    } catch (err) {
      setLoginError(err.message || "Couldn't log in — try again.");
    } finally {
      setLoggingIn(false);
    }
  }, [username, password, enterApp]);

  const handlePasswordChanged = useCallback(async () => {
    const status = await api.getAuthStatus();
    if (status.authenticated) await enterApp(status);
  }, [enterApp]);

  // Optimistic: show the new ranking at once, save in the background, roll back on failure.
  const handleSaveRanking = useCallback(async (leagueId, order) => {
    let previous;
    setLiveLeagues((prev) =>
      prev.map((l) => {
        if (l.id !== leagueId) return l;
        previous = l.customRanking;
        return { ...l, customRanking: order };
      })
    );
    try {
      await api.saveRanking(leagueId, order);
    } catch (err) {
      setLiveLeagues((prev) => prev.map((l) => (l.id === leagueId ? { ...l, customRanking: previous ?? null } : l)));
      throw err;
    }
  }, []);

  const handleToggleLeague = useCallback((id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const handleConfirmSelection = useCallback(async () => {
    setLoadingLeagues(true);
    setConnectError(null);
    try {
      // Drop leagues that are no longer tracked, then build the chosen ones.
      setLiveLeagues((prev) => prev.filter((l) => selectedIds.includes(l.id)));
      const { week: builtWeek } = await buildAll(sessionId, selectedIds, week);
      setWeek(builtWeek);
      setSyncedAt("just now");
      // No client-side persistence call needed here — the build endpoint
      // already saves the tracked list server-side, which is what
      // reconnectFromLastSession() reads on the next login/bootstrap.
      navigate({ screen: "dashboard" });
    } catch (err) {
      setConnectError(err.message || "Couldn't load those leagues — try again.");
    } finally {
      setLoadingLeagues(false);
    }
  }, [sessionId, selectedIds, week, navigate, buildAll]);

  // v3.5: the refresh button passes { manual: true } so trade offers and pending claims are re-read live;
  // the 30-minute auto refresh doesn't.
  const handleRefresh = useCallback(async ({ manual = false, opened = false } = {}) => {
    if (!sessionId || selectedIds.length === 0) return;
    setRefreshing(true);
    try {
      const { week: builtWeek } = await buildAll(sessionId, selectedIds, week, { manual, opened });
      setWeek(builtWeek);
      setSyncedAt("just now");
    } catch (err) {
      setConnectError(err.message || "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, selectedIds, week, buildAll]);

  const handleWeekChange = useCallback(
    async (newWeek) => {
      if (!sessionId || selectedIds.length === 0) {
        setWeek(newWeek);
        return;
      }
      setWeek(newWeek);
      // Show the last build we have for that week straight away (marked as a saved copy), then rebuild.
      const cached = weekCache.current.get(newWeek);
      if (cached) setLiveLeagues(cached.map((l) => ({ ...l, fromCache: true })));
      setRefreshing(true);
      try {
        const { week: builtWeek } = await buildAll(sessionId, selectedIds, newWeek);
        setWeek(builtWeek ?? newWeek);
        setSyncedAt("just now");
      } catch (err) {
        setConnectError(err.message || "Couldn't load that week.");
      } finally {
        setRefreshing(false);
      }
    },
    [sessionId, selectedIds, buildAll]
  );

  const refreshRef = useRef(handleRefresh);
  refreshRef.current = handleRefresh;
  useEffect(() => {
    if (!sessionId || selectedIds.length === 0) return;
    const id = setInterval(() => refreshRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [sessionId, selectedIds.length]);

  // v4.4.1: coming back to the app after 5+ minutes away counts as opening it again (the server only acts on this under the Medium preset).
  useEffect(() => {
    if (!sessionId || selectedIds.length === 0) return undefined;
    let hiddenAt = null;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt != null && Date.now() - hiddenAt >= 5 * 60 * 1000) { hiddenAt = null; refreshRef.current({ opened: true }); }
      else hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sessionId, selectedIds.length]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // A network failure logging out shouldn't trap someone on the
      // dashboard — clear local state and send them to the login screen
      // regardless; the server-side session just won't be revoked until
      // it naturally expires.
    }
    weekCache.current.clear();
    buildSeq.current += 1;
    setSessionId(null);
    setSleeperUser(null);
    setAvailableLeagues([]);
    setSelectedIds([]);
    setLiveLeagues([]);
    setWeek(null);
    setAuthUser(null);
    setUsername("");
    setPassword("");
    setConnectError(null);
    setLoginError(null);
    navigate({ screen: "login" });
  }, [navigate]);

  const handleEditLeagues = useCallback(async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      const { sessionId: freshSessionId, user, leagues } = await api.connect();
      setSessionId(freshSessionId);
      setSleeperUser(user);
      setAvailableLeagues(leagues);
      const validIds = leagues.map((l) => l.league_id);
      const currentIds = liveLeagues.map((l) => l.id).filter((id) => validIds.includes(id));
      setSelectedIds(currentIds.length ? currentIds : validIds);
      navigate({ screen: "select" });
    } catch (err) {
      setConnectError(err.message || "Couldn't refresh your league list — try again.");
    } finally {
      setConnecting(false);
    }
  }, [liveLeagues, navigate]);

  // v2.7: keep the Pick'em tab's red dot current even when the tab isn't open.
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return undefined;
    const check = () => api.getPickem().then((d) => setPickemChanged(d.changedCount || 0)).catch(() => {});
    check();
    const id = setInterval(check, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [authUser]);

  // v3.8: charter status per league (the "Commish" box on league cards and the tab's red dot).
  const [commishSummary, setCommishSummary] = useState({});
  const loadCommishSummary = useCallback(() => {
    api.getCommishSummary().then((r) => setCommishSummary(r.byLeague || {})).catch(() => {});
  }, []);
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return undefined;
    loadCommishSummary();
    const id = setInterval(loadCommishSummary, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [authUser, loadCommishSummary]);
  useEffect(() => {
    if (view.screen === "dashboard" && authUser && !authUser.mustChangePassword) loadCommishSummary();
  }, [view.screen, authUser, loadCommishSummary]);

  // v2.8.1: load cleared variances; after each build, drop clears for issues
  // that have gone away (so if one comes back it's new again).
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return;
    api.getVarianceAcks().then((r) => setAcks(new Set(r.keys || []))).catch(() => {});
  }, [authUser]);
  // v2.9: clears for issues that have gone away are only dropped after a
  // COMPLETE, fresh, live build of every tracked league for one week — never
  // after a saved copy, a stale fallback, a failed league or a half-finished
  // progressive build (those make issues look like they vanished, which then
  // wrongly un-clears them when they "reappear"). `ackEpoch` stops a slow
  // prune response from overwriting a clear the person made in the meantime.
  const ackEpoch = useRef(0);
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword || refreshing) return;
    if (!rawComputed.length) return;
    const complete = rawComputed.every((lg) => !lg.error && !lg.stale && !lg.fromCache);
    const sameWeek = new Set(rawComputed.map((lg) => lg.week)).size === 1;
    const tracked = selectedIds.length === 0 || selectedIds.every((id) => rawComputed.some((lg) => lg.id === id));
    if (!complete || !sameWeek || !tracked) return;
    const present = rawComputed.flatMap((lg) => collectVariances(lg).map((v) => v.key));
    const epoch = ackEpoch.current;
    api
      .pruneVarianceAcks(rawComputed.map((lg) => lg.id), rawComputed[0].week, present)
      .then((r) => {
        if (epoch === ackEpoch.current) setAcks(new Set(r.keys || []));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawComputed, authUser, refreshing]);
  const clearVariances = useCallback(async (keys) => {
    ackEpoch.current += 1;
    setAcks((prev) => new Set([...prev, ...keys])); // optimistic
    try {
      const r = await api.ackVariances(keys);
      setAcks(new Set(r.keys || []));
    } catch {
      setAcks((prev) => {
        const n = new Set(prev);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  }, []);

  // v2.9: auto-clearing minors (weather, big-gap trades) are acknowledged once
  // their page has been viewed and left — so they show on the first visit and
  // not on later ones unless they come back.
  const prevView = useRef(null);
  const computedRef = useRef(computed);
  computedRef.current = computed;
  useEffect(() => {
    const prev = prevView.current;
    prevView.current = view;
    if (!prev || prev.screen !== "tab" || !STATUS_BADGE_TABS.includes(prev.tab)) return;
    if (view.screen === "tab" && view.leagueId === prev.leagueId && view.tab === prev.tab) return;
    const lg = computedRef.current.find((l) => l.id === prev.leagueId);
    const keys = autoClearKeys(lg?.variances || [], { leagueId: prev.leagueId, page: prev.tab });
    if (keys.length) clearVariances(keys);
  }, [view, clearVariances]);
  const openVariances = useCallback((scope) => setModal({ type: "variances", scope }), []);

  // v2.8: fetch the matchup table for each scoring profile in use; re-fetch
  // when the Analytics sample/adjust settings change.
  const profileKeys = useMemo(() => [...new Set(liveLeagues.map((l) => l.scoringProfile).filter(Boolean))].sort(), [liveLeagues]);
  const profileSig = JSON.stringify(profileKeys); // profile keys contain "|", so no string joining
  useEffect(() => {
    if (!authUser || authUser.mustChangePassword) return;
    for (const p of JSON.parse(profileSig)) {
      api.getDvp({ profile: p }).then((t) => setDvpTables((prev) => ({ ...prev, [p]: t }))).catch(() => {});
    }
  }, [profileSig, dvpVersion, authUser]);
  const cardCtx = useMemo(
    () => ({
      dvpRow: (profile, side, pos, team) => {
        const t = dvpTables[profile];
        if (!t || t.profile !== profile) return null;
        return (side === "off" ? t.offense : t.defense)?.[pos]?.find((r) => r.team === team) || null;
      },
      openDvp: (params) => setModal({ type: "dvp", params }),
      openWeather: (key) => setModal({ type: "weather", key, week }),
    }),
    [dvpTables, week]
  );
  const closeModal = useCallback(() => setModal(null), []);

  // v3.5: player card pop-up. Opened from any player (PlayerLink); the league on screen — or the one the caller
  // names, e.g. a Game Day row — is the context for scoring, ownership, transactions and trade values.
  const [cardTarget, setCardTarget] = useState(null);
  const activeLeagueRef = useRef(activeLeague);
  activeLeagueRef.current = activeLeague;
  const playerCardCtx = useMemo(
    () => ({
      open: (player, opts = {}) => {
        const lg = (opts.leagueId && computedRef.current.find((l) => l.id === opts.leagueId)) || activeLeagueRef.current || null;
        setCardTarget({ player: { ...player, profile: player.profile || lg?.scoringProfile || null }, leagueId: lg?.id || opts.leagueId || null });
      },
    }),
    []
  );
  const closeCard = useCallback(() => setCardTarget(null), []);
  // Moving to another page closes the card.
  useEffect(() => setCardTarget(null), [view]);

  // Breadcrumb trail: username > League Name > Sub tab name. Every level
  // but the current one is clickable.
  const crumbs = useMemo(() => {
    const root = { label: sleeperUser?.display_name || "Fantasy Manager", onClick: liveLeagues.length ? () => navigate({ screen: "dashboard" }) : undefined, root: true };
    if (view.screen === "bootstrapping") return [{ label: "Fantasy Manager" }];
    if (view.screen === "login") return [{ label: "Fantasy Manager" }];
    if (view.screen === "forceChange") return [{ label: "Change password" }];
    if (view.screen === "account") return [root, { label: "Account" }];
    if (view.screen === "analytics") return [{ label: "Analytics" }];
    if (view.screen === "gameday") return [{ label: "Game Day" }];
    if (view.screen === "pickem") return [{ label: "Pick'em" }];
    if (view.screen === "commish") return [{ label: "Commish" }];
    if (view.screen === "admin") return [root, { label: "Account", onClick: () => navigate({ screen: "account" }) }, { label: "Manage users" }];
    if (view.screen === "select") return liveLeagues.length ? [root, { label: "Edit Leagues" }] : [{ label: "Choose Leagues" }];
    if (view.screen === "dashboard") return [{ label: root.label, root: true }];
    // v3.9: the league name and the page name are drop-downs — jump to another league (same page) or another page.
    const tabKey = view.tab === "lineup" ? "roster" : view.tab;
    const leagueOptions = (current) => [
      ...(view.screen === "tab" ? [{ key: "overview", label: "League overview", onSelect: () => navigate({ screen: "league", leagueId: activeLeague.id }) }, { divider: true }] : []),
      ...liveLeagues.map((l) => ({
        key: l.id,
        label: l.name || l.id,
        current: l.id === current,
        onSelect: () => navigate(view.screen === "tab" ? { screen: "tab", leagueId: l.id, tab: tabKey } : { screen: "league", leagueId: l.id }),
      })),
    ];
    if (view.screen === "league" && activeLeague) return [root, { label: activeLeague.name, menuKey: "league", options: leagueOptions(activeLeague.id) }];
    if (view.screen === "tab" && activeLeague) return [root, { label: activeLeague.name, menuKey: "league", options: leagueOptions(activeLeague.id) }, { label: (TAB_META[tabKey] || TAB_META.roster).label }]; // v4.1: plain text again — the league tabs switch pages
    return [root];
  }, [view, sleeperUser, liveLeagues, activeLeague, navigate]);

  const showRefresh = view.screen === "dashboard" || view.screen === "league" || view.screen === "tab";
  const showWeek = showRefresh && week != null;

  return (
    <CardCtx.Provider value={cardCtx}>
    <PlayerCardCtx.Provider value={playerCardCtx}>
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "Inter, sans-serif" }} className="max-w-lg mx-auto">
      {cardTarget && <PlayerCardModal target={cardTarget} onClose={closeCard} />}
      {modal?.type === "dvp" && <DvpDetailModal params={modal.params} onClose={closeModal} />}
      {modal?.type === "weather" && <WeatherModal gameKey={modal.key} week={modal.week} onClose={closeModal} />}
      {modal?.type === "variances" && (() => {
        const sc = modal.scope || {};
        const lg = sc.leagueId ? computed.find((l) => l.id === sc.leagueId) : null;
        const list = computed.flatMap((l) => l.variances || []).filter((v) => (!sc.leagueId || v.leagueId === sc.leagueId) && (!sc.page || v.page === sc.page));
        const title = sc.page ? `Variances · ${lg?.name || ""} · ${PAGE_LABEL[sc.page]}` : sc.leagueId ? `Variances · ${lg?.name || ""}` : "Variances · all leagues";
        return <VarianceReportModal title={title} variances={list} onClear={clearVariances} onClose={closeModal} />;
      })()}
      <TopBar
        crumbs={crumbs}
        onRefresh={showRefresh ? () => handleRefresh({ manual: true }) : undefined}
        refreshing={refreshing}
        week={week}
        onWeekChange={handleWeekChange}
        showWeek={showWeek}
        userMenu={
          authUser && !authUser.mustChangePassword && !["login", "bootstrapping", "forceChange"].includes(view.screen)
            ? {
                name: sleeperUser?.display_name || authUser.username,
                avatar: sleeperUser?.avatar || null,
                onEditLeagues: handleEditLeagues,
                onOpenAccount: () => navigate({ screen: "account" }),
                onLogout: handleLogout,
                onHome: liveLeagues.length ? () => navigate({ screen: "dashboard" }) : undefined,
              }
            : null
        }
      />
      {authUser && !authUser.mustChangePassword && !["login", "bootstrapping", "forceChange"].includes(view.screen) && (
        <TabBar
          active={["gameday", "analytics", "pickem", "commish"].includes(view.screen) ? view.screen : "leagues"}
          dots={{ pickem: pickemChanged > 0, commish: Object.values(commishSummary).some((x) => x.status === "red") }}
          onSelect={(tab) => {
            if (tab === "gameday") navigate({ screen: "gameday" });
            else if (tab === "pickem") navigate({ screen: "pickem" });
            else if (tab === "commish") navigate({ screen: "commish" });
            else if (tab === "analytics") navigate({ screen: "analytics" });
            else navigate(liveLeagues.length ? { screen: "dashboard" } : { screen: "select" });
          }}
        />
      )}
      {(view.screen === "league" || view.screen === "tab") && activeLeague && (
        <LeagueTabs
          active={view.screen === "league" ? "overview" : view.tab === "lineup" ? "roster" : view.tab}
          statusOf={(k) => activeLeague[k]?.status}
          onSelect={(k) => navigate(k === "overview" ? { screen: "league", leagueId: activeLeague.id } : { screen: "tab", leagueId: activeLeague.id, tab: k })}
        />
      )}
      {view.screen === "bootstrapping" && <BootstrapScreen />}
      {view.screen === "login" && (
        <LoginScreen username={username} setUsername={setUsername} password={password} setPassword={setPassword} onSubmit={handleLoginSubmit} loading={loggingIn} error={loginError} />
      )}
      {view.screen === "dashboard" && (
        <Dashboard
          computed={computed}
          onOpenLeague={(id) => navigate({ screen: "league", leagueId: id })}
          onOpenTab={(id, tab) => navigate({ screen: "tab", leagueId: id, tab })}
          onLogout={handleLogout}
          onEditLeagues={handleEditLeagues}
          onOpenAccount={() => navigate({ screen: "account" })}
          sleeperUser={sleeperUser}
          onOpenVariances={openVariances}
          commishSummary={commishSummary}
          onOpenCommish={(id) => navigate({ screen: "commish", commishLeagueId: id })}
        />
      )}
      {view.screen === "forceChange" && <ForcePasswordScreen authUser={authUser} onDone={handlePasswordChanged} onLogout={handleLogout} />}
      {view.screen === "analytics" && <AnalyticsScreen authUser={authUser} leagues={computed} onDvpChange={() => setDvpVersion((v) => v + 1)} />}
      {view.screen === "gameday" && <GameDayScreen />}
      {view.screen === "pickem" && <PickemScreen onChangedCount={setPickemChanged} />}
      {view.screen === "commish" && <CommishScreen key={view.commishLeagueId || "all"} initialLeagueId={view.commishLeagueId || null} onSummaryChange={loadCommishSummary} />}
      {view.screen === "account" && <AccountScreen authUser={authUser} onOpenAdmin={() => navigate({ screen: "admin" })} onLogout={handleLogout} />}
      {view.screen === "admin" && authUser?.role === "owner" && <AdminScreen authUser={authUser} />}
      {view.screen === "select" && (
        <SelectLeaguesScreen leagues={availableLeagues} selectedIds={selectedIds} onToggle={handleToggleLeague} onConfirm={handleConfirmSelection} loading={loadingLeagues || connecting} error={connectError} />
      )}
      {view.screen === "league" && activeLeague && (
        <LeagueOverview league={activeLeague} onOpenVariances={openVariances} onOpenTab={(tab) => navigate({ screen: "tab", leagueId: activeLeague.id, tab })} />
      )}
      {view.screen === "tab" && activeLeague && (() => {
        if (activeLeague.error) return <ErrorScreen message={activeLeague.error} />;
        const tabKey = view.tab === "lineup" ? "roster" : view.tab; // v3.0: Lineup merged into Roster
        const Comp = TAB_COMPONENTS[tabKey];
        const pageVariances = (activeLeague.variances || []).filter((v) => v.page === tabKey);
        return (
          <>
            {STATUS_BADGE_TABS.includes(tabKey) && (
              <div className="flex justify-end items-center gap-2 px-4 pt-3 -mb-1">
                <ClearVariancesButton variances={pageVariances} onClear={clearVariances} />
                <VarianceButton variances={pageVariances} onOpen={() => openVariances({ leagueId: activeLeague.id, page: tabKey })} label="Variance report — this page" />
              </div>
            )}
            <Comp league={activeLeague} allLeagues={computed} onOpenTab={(id, tab) => navigate({ screen: "tab", leagueId: id, tab })} sessionId={sessionId} onSaveRanking={handleSaveRanking} onRefresh={() => handleRefresh({ manual: true })} onOpenAccount={() => navigate({ screen: "account" })} onClearVariances={clearVariances} />
          </>
        );
      })()}
      {showRefresh && (
        // v3.5: sync status lives at the bottom of the page instead of under the header
        <div className="px-4 pt-2 pb-6 text-[11px]" style={{ color: C.textFaint }} data-sync-status>
          {`${computed.some((l) => l.fromCache) ? "Showing your last saved data — updating live… · " : ""}Synced ${syncedAt} · ${sourceStatusLabel(sourceStatus)}`}
        </div>
      )}
    </div>
    </PlayerCardCtx.Provider>
    </CardCtx.Provider>
  );
}
