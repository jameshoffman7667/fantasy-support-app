import { METRICS } from "./advancedStats.js";

/**
 * v4.2: how each stat in the stats list (config/stats-config.json, editable through the spreadsheet) is worked out,
 * plus the text the Scouting column pop-up shows (definition and source).
 *
 *   line      a key in the weekly stat line (Sleeper's stat names; nflverse fills gaps / older seasons). Summed over
 *             the chosen weeks; Season average divides by games played.
 *   adv       a metric from advancedStats.aggregate() over the chosen weeks (rates and shares — never divided again)
 *   calc      worked out from other sums (WOPR, RACR, yards per carry …)
 *   current   only exists today (no past weeks or seasons) — blank and not selectable once a time filter is on
 *   better    "high" | "low" | null — which way is good (suggested bands, colours)
 *   rate      a rate/share: Season average keeps it as the value over all the chosen games
 */
const SLEEPER = "Sleeper weekly stats (nflverse for seasons Sleeper doesn't have)";
const SLEEPER_PROJ = "Sleeper weekly projections";
const NFLVERSE = "nflverse player stats (github.com/nflverse)";
const NGS = "NFL Next Gen Stats via nflverse";
const PFR = "Pro Football Reference advanced stats via nflverse";
const EST = "Estimate: offensive snaps × the team's dropback rate that week (nflverse snap counts and team stats)";

export const DEFS = {
  fpts: { calc: "fpts", better: "high", def: "Fantasy points scored with the chosen league's own scoring settings (projected or actual), added up week by week.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rostered_pct: { current: "rostered", better: "high", def: "Share of ESPN fantasy leagues that roster the player.", src: "ESPN fantasy player feed (ownership.percentOwned)" },
  age: { current: "age", better: "low", def: "Age today.", src: "Sleeper player directory" },
  proj_rank: { calc: "proj_rank", better: "low", def: "Rank at his position by projected fantasy points for the chosen weeks (1 = best).", src: SLEEPER_PROJ },
  ros_pts: { current: "ros", better: "high", def: "Projected fantasy points for the rest of the season, from this week to the league's last fantasy week.", src: SLEEPER_PROJ },
  proj_source: { current: "proj_source", better: null, def: "Which source the app's projection comes from (Vegas, Tank01, Sleeper or ESPN).", src: "The app's projection hub", text: true },
  ecr: { current: "ecr", better: "low", def: "FantasyPros expert consensus rank at his position (1 = best).", src: "FantasyPros consensus rankings" },
  hype_mentions: { current: "hype", better: "high", def: "How many waiver articles, Reddit posts and X posts this week recommend him (Hype Train research).", src: "Gemini grounded search of this week's waiver coverage" },
  trend_adds: { current: "trend", better: "high", def: "How many Sleeper leagues added him in the last 24 hours.", src: "Sleeper trending players" },
  snaps: { line: "nv_snaps", fallback: "off_snp", better: "high", def: "Offensive snaps played.", src: "nflverse snap counts (Pro Football Reference)" },
  snap_pct: { adv: "snapPct", rate: true, better: "high", def: "Share of the team's offensive snaps he played (average of his games).", src: "nflverse snap counts (Pro Football Reference)" },
  dynasty_value: { current: "dynasty", better: "high", def: "Dynasty trade value (Roster Audit, FantasyCalc when Roster Audit is unavailable).", src: "Roster Audit / FantasyCalc" },
  st_td: { line: "st_td", better: "high", def: "Special teams touchdowns (returns).", src: NFLVERSE },
  pass_yd: { line: "pass_yd", better: "high", def: "Passing yards.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  pass_td: { line: "pass_td", better: "high", def: "Passing touchdowns.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  pass_int: { line: "pass_int", better: "low", def: "Interceptions thrown.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  pass_cmp: { line: "pass_cmp", better: "high", def: "Completed passes.", src: SLEEPER },
  pass_att: { line: "pass_att", better: "high", def: "Pass attempts.", src: SLEEPER },
  sacks_taken: { line: "nv_sacks", fallback: "pass_sack", better: "low", def: "Times sacked.", src: NFLVERSE },
  pass_air_yd: { line: "nv_pass_air_yd", better: "high", def: "Air yards on all pass attempts (yards the ball travelled past the line of scrimmage).", src: NFLVERSE },
  pass_2pt: { line: "pass_2pt", better: "high", def: "Passing two-point conversions.", src: SLEEPER },
  epa_dropback: { adv: "epaPerDropback", rate: true, better: "high", def: "Expected points added per dropback (passes + sacks).", src: NFLVERSE },
  pressure_rate: { adv: "pressureRate", rate: true, better: "low", def: "Share of dropbacks under pressure.", src: PFR },
  bad_throw: { adv: "badThrowPct", rate: true, better: "low", def: "Share of pass attempts charted as bad throws.", src: PFR },
  intended_air: { adv: "qbAdot", rate: true, better: null, def: "Average intended air yards per attempt.", src: NGS },
  time_to_throw: { adv: "timeToThrow", rate: true, better: null, def: "Average seconds from snap to throw.", src: NGS },
  pass_epa: { line: "nv_pass_epa", better: "high", def: "Total expected points added on passing plays.", src: NFLVERSE },
  cpoe: { adv: "cpoe", rate: true, better: "high", def: "Completion percentage above what's expected given each throw's difficulty.", src: `${NGS} (nflverse play-by-play before 2016)` },
  rec_tgt: { line: "rec_tgt", better: "high", def: "Targets.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rec: { line: "rec", better: "high", def: "Receptions.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rec_yd: { line: "rec_yd", better: "high", def: "Receiving yards.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rec_td: { line: "rec_td", better: "high", def: "Receiving touchdowns.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  target_share: { adv: "targetShare", rate: true, better: "high", def: "Share of his team's targets.", src: NFLVERSE },
  rec_2pt: { line: "rec_2pt", better: "high", def: "Receiving two-point conversions.", src: SLEEPER },
  tprr: { adv: "tprr", rate: true, better: "high", def: "Targets per route run (estimated routes).", src: EST },
  yprr: { adv: "yprr", rate: true, better: "high", def: "Receiving yards per route run (estimated routes).", src: EST },
  adot: { adv: "adot", rate: true, better: null, def: "Average depth of target: air yards per target.", src: NFLVERSE },
  separation: { adv: "separation", rate: true, better: "high", def: "Average yards of separation from the nearest defender when the ball arrives.", src: NGS },
  cushion: { adv: "cushion", rate: true, better: null, def: "Average yards between him and the defender at the snap.", src: NGS },
  yac_oe: { adv: "yacOe", rate: true, better: "high", def: "Yards after catch above what's expected per reception.", src: NGS },
  drop_rate: { adv: "dropRate", rate: true, better: "low", def: "Drops per target.", src: PFR },
  rec_yac: { line: "nv_rec_yac", better: "high", def: "Receiving yards after the catch.", src: NFLVERSE },
  rec_air_yd: { line: "nv_rec_air_yd", better: "high", def: "Air yards on his targets.", src: NFLVERSE },
  rec_epa: { line: "nv_rec_epa", better: "high", def: "Total expected points added when targeted.", src: NFLVERSE },
  air_yd_share: { adv: "airYardsShare", rate: true, better: "high", def: "Share of his team's air yards.", src: NFLVERSE },
  wopr: { calc: "wopr", rate: true, better: "high", def: "Weighted opportunity rating: 1.5 × target share + 0.7 × air yards share.", src: NFLVERSE },
  racr: { calc: "racr", rate: true, better: "high", def: "Receiver air conversion ratio: receiving yards per air yard targeted.", src: NFLVERSE },
  rush_att: { line: "rush_att", better: "high", def: "Carries.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rush_yd: { line: "rush_yd", better: "high", def: "Rushing yards.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  rush_td: { line: "rush_td", better: "high", def: "Rushing touchdowns.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  fum_lost: { line: "fum_lost", better: "low", def: "Fumbles lost (rushing, receiving and on sacks).", src: SLEEPER },
  ypc: { calc: "ypc", rate: true, better: "high", def: "Rushing yards per carry.", src: SLEEPER },
  rush_2pt: { line: "rush_2pt", better: "high", def: "Rushing two-point conversions.", src: SLEEPER },
  ryoe: { adv: "ryoe", rate: true, better: "high", def: "Rushing yards over expected per carry.", src: NGS },
  yaco_per_carry: { adv: "yacPerCarry", rate: true, better: "high", def: "Rushing yards after contact per carry.", src: PFR },
  broken_tackles: { adv: "brokenTacklesPerCarry", rate: true, better: "high", def: "Broken tackles per carry.", src: PFR },
  stacked_box: { adv: "stackedBox", rate: true, better: null, def: "Share of his carries against 8 or more defenders in the box.", src: NGS },
  rush_epa: { line: "nv_rush_epa", better: "high", def: "Total expected points added on his carries.", src: NFLVERSE },
  carry_share: { adv: "carryShare", rate: true, better: "high", def: "Share of his team's carries.", src: NFLVERSE },
  implied_total: { current: "implied", better: "high", def: "His team's implied points this week (from the betting total and spread).", src: "Tank01 sportsbook lines (this week only)" },
  spread: { current: "spread", better: "low", def: "His team's point spread this week (negative = favourite).", src: "Tank01 sportsbook lines (this week only)" },
  prop_pass_yd: { current: "prop:passyds", better: "high", def: "Sportsbook passing-yards line this week.", src: "Tank01 player props (this week only)" },
  prop_rush_yd: { current: "prop:rushyds", better: "high", def: "Sportsbook rushing-yards line this week.", src: "Tank01 player props (this week only)" },
  prop_rec_yd: { current: "prop:recyds", better: "high", def: "Sportsbook receiving-yards line this week.", src: "Tank01 player props (this week only)" },
  prop_anytd: { current: "prop:anytd", better: "low", def: "Sportsbook odds for an anytime touchdown this week (American odds; lower = likelier).", src: "Tank01 player props (this week only)" },
  def_sack: { line: "sack", better: "high", def: "Sacks by the defense.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  def_int: { line: "int", better: "high", def: "Interceptions by the defense.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  def_fum_rec: { line: "fum_rec", better: "high", def: "Fumbles recovered by the defense.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  def_td: { line: "def_td", better: "high", def: "Defensive touchdowns.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  pts_allow: { line: "pts_allow", better: "low", def: "Points allowed.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  yds_allow: { line: "yds_allow", better: "low", def: "Yards allowed.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  fgm: { line: "fgm", better: "high", def: "Field goals made.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  xpm: { line: "xpm", better: "high", def: "Extra points made.", src: { stat: SLEEPER, proj: SLEEPER_PROJ } },
  fga: { line: "fga", better: "high", def: "Field goal attempts.", src: SLEEPER },
  xpa: { line: "xpa", better: "high", def: "Extra point attempts.", src: SLEEPER },
};

// Advanced-stat thresholds the player card already uses: [goodAt, badAt] per position.
const FIXED = Object.fromEntries(METRICS.filter((m) => m.fixed).map((m) => [m.key, m.fixed]));

/** What the client needs per stat (no functions). */
export function publicDefs() {
  const out = {};
  for (const [id, d] of Object.entries(DEFS)) {
    out[id] = {
      def: d.def,
      src: d.src,
      better: d.better ?? null,
      current: Boolean(d.current),
      rate: Boolean(d.rate),
      text: Boolean(d.text),
      fixed: d.adv && FIXED[d.adv] ? FIXED[d.adv] : null,
    };
  }
  return out;
}
