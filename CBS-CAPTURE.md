# CBS pick'em auto mode — setup and troubleshooting (v3.3)

v3.3 talks to CBS the same way your browser does (sign-in, then the picks site's GraphQL API). You no longer need to write a "recipe". The older recipe mode is still there under Account → CBS pick'em push → Advanced, in case CBS changes things.

**Never paste your CBS password or cookies into the chat.** The password goes only in Account → CBS pick'em push. If something needs debugging, share request details with password, cookies and tokens replaced by `REDACTED`, and for cookies only their *names*. Don't use "Save all as HAR".

## Set up (5 minutes)

1. Account → CBS pick'em push: enter your CBS email and password, Save login.
2. For each pool: open its picks page on cbssports.com in your browser and copy the address from the address bar. It looks like `https://picks.cbssports.com/football/pools/…?entryId=…`. Paste one address per line (optional name after it) and press Save pools.
3. Press **Test login**. It signs in, reads the first pool, and reports the cookie *names* it received. A green result means the whole chain works.
4. Press **Preview** on the Pick'em screen: it reads CBS and shows what would be sent. It sends nothing.
5. Switch on **Auto mode**. The first run uses only the first pool until you confirm the result.

## How auto mode behaves
- About 60 minutes before each kickoff slot, your picks for that slot's games are sent to every pool. Games that have started or are locked are never sent. The app reads the saved picks back from CBS's reply to confirm.
- The app looks at CBS about every 30 minutes while auto mode is on. If a pick on a game that hasn't started differs from what the app last saved (you changed it on CBS), auto mode switches itself off and you get a notification.
- Choosing a pick yourself in the app while auto mode is on asks first, and confirming switches auto mode off.
- Push now sends immediately (with a confirmation); it is never blocked by auto mode.

## If the test login fails
- **"Sign-in id not recognised"**: CBS changed its site. The app tries to find the new id itself (up to 3 candidates) and saves the one that works. Advanced shows the id in use; you can replace it by copying the `next-action` header of the sign-in request in the Network tab.
- **Captcha / refused**: CBS may reject scripted sign-ins (the login page uses reCAPTCHA). Nothing can be done in the app; tell me what the error says.
- **Signed in but the picks site refuses**: the cookie hand-off between the two CBS hosts is the unverified part. The test reports cookie names only; share those names.
- **Picks page changed**: the picks requests use CBS's saved-query hashes; if CBS changes them the app says so. Advanced lets you replace them (copy from the Network tab URL `extensions=` / request body).

The app only talks to hosts under cbssports.com (`CBS_ALLOWED_HOSTS` to change). The user agent defaults to an honest "Mozilla/5.0 (compatible; fantasy-manager)" (`CBS_USER_AGENT` to change).

## Older recipe mode (Advanced)
Kept from v3.2. Switch with the Advanced toggle, then paste a JSON recipe as described in the v3.2 notes (login, submit, optional games lookup and read-back).
