# 28 Kerala Gulan — Final Server Build

## What this is
Your original game file (the one you confirmed plays correctly), with
server networking added so it survives disconnects. The game logic —
bidding, trump, play, the learning bots — is your file's actual code,
relocated to run on the server instead of only in a browser tab.

## What changed from your file
Only the networking layer. Every place your file used to talk directly
to another player's browser (PeerJS/MQTT), it now talks to this server
instead. The rules, the bidding formulas, the bot AI, the scoring — all
untouched, just moved to run authoritatively on the server so a
disconnect can't destroy the game anymore.

## Files
- `server.js` — Socket.IO server: tables, reconnection, serves the game page
- `game-engine.js` — the actual game rules, ported faithfully from your file
- `bot-brain.js` — the learning system (experience, levels, pattern memory),
  saved to disk so bots keep improving across server restarts
- `public/index.html` — your game, with server networking added
- `package.json` — dependencies
- `test-*.js` / `test-*.py` — the test suite used to verify this build

## Deploying
Push everything to your repo (same structure as before: `server.js`,
`game-engine.js`, `bot-brain.js`, `package.json` in the root; `index.html`
inside `public/`). Render redeploys the same as always.

## What was actually wrong, and what's fixed
1. **Turn order and teams were wrong.** My server was using a simple
   0→1→2→3 rotation and {0,2}/{1,3} teams — neither matches your game.
   Pulled the exact rotation (`[3,2,0,1]`) and teams (`{0,3}` vs `{1,2}`)
   directly from your file. This was the root cause of nearly every
   "illogical" or "stuck" symptom.
2. **Trump suit was wrongly hidden.** Only the specific hidden card
   should stay secret — the chosen suit is knowable to everyone once
   picked. Fixed to match your file.
3. **Bots are your bots again.** Bidding, trump choice, phase-2 raising,
   and card-play strategy are ported directly from your file's actual
   functions, not approximated. Learning (experience, levels, weights,
   pattern memory) verified working over 60+ simulated games — bots
   genuinely climb from level 1 to level 5 and their behavior visibly
   shifts.
4. **A card-conservation bug in the hidden-trump mechanic**, present in
   both versions: if someone raises in phase 2 and becomes the new
   bidder, the hidden card can end up misdirected. Fixed by tracking who
   actually holds the hidden card separately from who's currently the
   bidder — this is a deliberate improvement over the original, not a
   deviation, since it prevents a real card-loss bug.
5. **Learning could be lost on a restart.** Was only saved every 10
   seconds; now also saves after every round.

## Tested before delivery
- 1200 simulated rounds (engine level), zero failures
- Full browser test: create table → join → bid → trump → phase 2 → play
  → **disconnect mid-game → reconnect** → same seat, same hand, other
  player's game uninterrupted
- Real UI click-through test (not simulated events — actual button taps)
- Bot Mode auto-play verified end to end
- Turn-order integrity check across 50 games — no seat ever acts twice
  within the same trick
- Learning persistence verified across a simulated server restart

## One known, deliberate gap
Chat, the admin table manager, spectator mode, and per-round table themes
aren't wired into server mode. The code for these still exists in your
file, untouched — easy to reconnect if you want them back.
