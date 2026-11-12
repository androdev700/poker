# Poker Night

No-Limit Texas Hold'em for up to 6 friends, played in the browser against a server on your own computer.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`, enter a name and create a table (buy-in, blinds, turn timer). The waiting
room shows the room code and join links.

- **Same Wi-Fi:** friends open the `http://<your-ip>:3000/?room=CODE` link shown in the waiting room.
  macOS may ask to allow incoming connections the first time.
- **Over the internet:** `npm run share` also opens an ngrok tunnel and shows its link in the waiting
  room. ngrok needs a one-time `ngrok config add-authtoken <token>`; its free tier shows visitors an
  interstitial page once.

`PORT=4000 npm start` or `npm start -- --port 4000` changes the port.

## How a table works

- Everyone who joins gets the buy-in. The host starts the game. After each hand the board, the shown
  cards and the winner stay up until the host taps **Deal next hand**.
- A player who loses all their chips is out and watches the rest of the session. There is no rebuy.
- A turn that runs out of time checks if it can and folds otherwise. A disconnected player is
  auto-checked/folded until they come back; refreshing the page or waking a phone restores the seat.
- A player who misses two turns in a row is marked away and auto-checked/folded straight away until
  they tap "tap to play".
- A player who is offline or away when a hand is dealt sits that hand out and is dealt back in once
  they return. A hand needs at least two players who are present and have chips.
- The table lives until the host closes it (menu → Close table) or the server is stopped with Ctrl+C.
  Either way everyone gets the final scoreboard. Tables are held in memory only.
- The button moves to the next player with chips each hand (no dead-button rule), so a blind can
  occasionally be skipped or repeated right after someone busts.

## Trying it alone

Add `?p=<anything>` to the URL to get a separate identity per tab, e.g. `/?p=a` and `/?p=b`.

## Tests

```bash
npm test
npm run bots -- --players 6 --hands 2000 --seed 1
```

`npm test` covers the hand evaluator, side pots, the game engine (including a seeded fuzz) and the room
layer. `npm run bots` plays random hands over real WebSockets and checks chip conservation and that no
hole cards leak.

## Layout

- `shared/` — card format, wire protocol, animation timings (used by server and browser)
- `server/engine/` — pure game logic: deck, evaluator, pots, game
- `server/` — HTTP + WebSocket server, rooms, per-player views, ngrok tunnel
- `client/` — Three.js table (`js/scene/`), HUD, lobby, action bar, sound, and the director that
  sequences animations from server events
