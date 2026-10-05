# CBS pick'em push — capture guide (v3.2)

CBS has no public API, and the build environment could not reach cbssports.com, so **the app does not know CBS's real URLs or form fields**. You supply them as a *recipe*: the requests your own browser makes when you sign in and submit picks. The app replays them with your picks filled in.

**Never paste your CBS password or cookies into the chat.** The password goes only in Account → CBS pick'em push. If you want help writing the recipe, send me the captured requests with the password, cookies and tokens replaced by `REDACTED`.

## What to capture (about 15 minutes, Chrome or Edge on a computer)

1. Open a private/incognito window and go to the CBS sign-in page. Press **F12** → **Network** tab. Tick **Preserve log**. Click the filter **Fetch/XHR**, then also look at **Doc** (some logins are plain form posts).
2. **Sign in.** In the list, find the request that carries your email/password (usually a POST named `login` or similar). Click it:
   - **Headers** tab: note the *Request URL* and *Request Method*.
   - **Payload** tab: note the fields. Is it form data or JSON? Note any hidden token field (names like `csrf`, `token`, `_token`).
   - **Response** or the page you land on: pick a piece of text that only appears when you are signed in (your name, "Sign Out").
3. Before signing in, note if a *different page* provides the token (view the sign-in page, search its source for the token's value). The recipe can fetch that page and pull the token out with a regex.
4. Clear the log. Open your pick'em pool's picks page and **change one pick and save/submit** (use a game that hasn't started, then change it back). Find the request that saved it:
   - Request URL (the pool id and game id appear in it, or in the payload), method, content type, payload fields.
   - Response: text that appears on success (for example `"success":true` or "Your picks were saved").
5. Open the picks page for a pool again (a GET). This is the **read-back**: the page or JSON that lists your saved picks. Note how each game and your chosen team appear.
6. Optional but useful: the request/page that lists the week's games with CBS's own game ids (the picks page itself usually does).

Tip: right-click a request → **Copy → Copy as cURL (bash)** gives everything in one block; remove the `-H 'cookie: …'` header and any password before sharing it.

## The recipe

Paste JSON like this into Account → CBS pick'em push → *Request recipe*. All URLs must be `https://…cbssports.com/…`.

```json
{
  "login": {
    "csrf": { "url": "https://www.cbssports.com/…sign-in page…", "regex": "name=\"token\" value=\"([^\"]+)\"" },
    "url": "https://…/login", "method": "POST", "contentType": "form",
    "body": "email={{email}}&password={{password}}&token={{csrf}}",
    "successIncludes": "Sign Out"
  },
  "submit": {
    "url": "https://…/pool/{{poolId}}/picks", "method": "POST", "contentType": "form",
    "mode": "perGame",
    "body": "game={{gameId}}&team={{pick}}&tiebreaker={{tiebreaker}}",
    "successIncludes": "success"
  },
  "games":    { "url": "https://…/pool/{{poolId}}/picks", "idRegex": "data-game=\"(?<id>\\d+)\" data-away=\"(?<away>[A-Z]+)\" data-home=\"(?<home>[A-Z]+)\"" },
  "readback": { "url": "https://…/pool/{{poolId}}/picks", "pickRegex": "data-game=\"(?<id>\\d+)\" data-pick=\"(?<team>[A-Z]+)\"" },
  "teamMap": { "JAC": "JAX", "WAS": "WSH" }
}
```

Only `login` and `submit` are required. Everything else is optional; leave it out if you don't need it.

**Placeholders** (`{{name}}`): in `login`: `email`, `password`, `csrf`. In `submit`: `poolId`, `season`, `week`, `tiebreaker`, `csrf`, and per game `gameId`, `away`, `home`, `pick` (the team you picked), `pickSide` (`home`/`away`), `pickOpp`, `gameKey` (like `KC@BUF`). `awayCode`/`homeCode`/`pickCode` are the app's own team codes before `teamMap` is applied.

**Fields**
- `contentType`: `form`, `json` or `raw`. Values are encoded for you.
- `mode`: `perGame` (one request per game, the default) or `batch` (one request; put `{{games}}` in `body` and describe one game in `itemBody`, joined with `itemSep`).
- `csrf` (login or submit): a page to GET first, and a regex whose first group is the token (becomes `{{csrf}}`).
- `successIncludes` / `failIncludes` / `successStatus`: how to tell success. Without any of them, any 2xx counts, which is weak evidence; set `successIncludes`.
- `games.idRegex`: a regex with named groups `id`, `away`, `home`, run over the page; builds `{{gameId}}`.
- `readback.pickRegex`: named groups `id` (or `game`) and `team`. After sending, the app reads the page and compares. Without a read-back the log says "sent, not verified".
- `teamMap`: only if CBS uses different team abbreviations (app code → CBS code).
- Extra `headers` (for example `X-Requested-With`) can be added to any step; `Cookie` and `Host` are ignored.

## First run (safe order)

1. Save login, pools (`poolId` is in your pool's URL; one per line) and recipe. **Test login**.
2. On the Pick'em screen press **Preview (sends nothing)**: it shows how many games and pools.
3. **Push now…** with auto-push still off. Only the *first pool* is used until a push is read back successfully (or you press "I checked it — use all pools" after looking at that pool on CBS yourself).
4. Look at the pool on cbssports.com. If the picks are right, switch **Auto-push** on. Use **Pause** any time.

Auto-push runs about 60 minutes before each kickoff slot, only for games that haven't started, retries up to 3 times (10 minutes apart) if CBS refuses, and notifies you after every push. Every attempt is in the log.

## Things that can go wrong

- CBS may use anti-bot protection, captchas, JavaScript-built tokens or two-step sign-in; a plain replay can't do those. The login test will say so ("login did not succeed").
- Your CBS terms may not allow automation. You accept that risk by switching it on.
- CBS changing its site will break the recipe; the log and notification will tell you.
- Lock time is assumed to be each game's kickoff (you said pools lock per game). If CBS locks earlier, set expectations accordingly: the 60-minute lead leaves room.
