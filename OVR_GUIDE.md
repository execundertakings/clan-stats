# OVR — Your Overall Rating, explained

OVR is the single number on the leaderboard that tries to capture how valuable you are to the squad — not just how many kills you get. A player who hits "elite" benchmarks in every category lands around 100. Nobody is fully elite across the board yet, so real scores currently sit between 30 and 95.

It's the default sort on the leaderboard. Click any column header to re-sort by whatever you care about.

## What goes into it

Five components add up to your OVR. Each component scores a stat against a benchmark — hit the benchmark and you get full marks for that line.

**Combat (up to 38 points)** — your fighting output.
- K/D, up to 22 pts (full marks at K/D 2.0)
- Average damage per game, up to 11 pts (full marks at 220 dmg/g)
- Headshot rate, up to 5 pts (full marks at 30%)

**Survival (up to 14 points)** — getting to the late game.
- Top-10 finish rate, up to 14 pts (full marks at 55%)

**Outcomes (up to 31 points)** — converting position into wins.
- Win rate, up to 21 pts (full marks at 12%)
- Close-out rate, up to 10 pts (full marks at 22%) — how often you win once you've made top-10

**Support (up to 20 points)** — squad contribution.
- Assists per game, up to 20 pts (full marks at 0.70)

**Volume (up to 6 points)** — commitment.
- You earn the full 6 pts at 250+ squad games. Below that, you get a proportional share. Nobody loses points for playing less — the bonus just doesn't apply yet.

Components don't cap individually, so if you have a freak stat (2.5 K/D, 15% win rate) you'll push past full marks in that area.

## What changed from the old rating

The old formula put 80% of the weight on raw fighting (K/D + damage + win rate). That made survival players and squad-supporters look weak even when they were directly helping the team win games. The new formula spreads the weight more honestly across what actually matters in squad PUBG: fighting, surviving, closing, supporting, and showing up.

In practice:
- Frag hard but die early often → your OVR is down a bit
- Survive late and rack up assists → your OVR is up
- Play a lot → you get a small bonus that caps at 250 games

## How to push your OVR up

OVR is designed so the things that actually win matches move the needle most. In rough order of leverage:

1. **Win rate (21 pts)** — biggest single lever. Stop pushing third parties. Take map edges in the final rings. Position over aggression.
2. **K/D (22 pts)** — fight selection over raw aggression. Take engagements with cover or height; disengage when exposed.
3. **Close-out rate (10 pts)** — small weight, high signal. If you keep making top-10 without winning, watch how you read the final circle. Move first, push count advantages, stop waiting for the zone to make your decisions for you.
4. **Assists per game (20 pts)** — easy to grow and now one of the highest-leverage components. Call enemy positions before pushes, soften targets and let teammates secure, communicate knocks. Squad coordination directly pays off here.

Things that won't move OVR much: total kills, total wins, longest kill, road kills, headshot count. The formula uses **rates**, not totals — playing more games doesn't artificially inflate your number.

## The "captured X/Y" badge next to some names

If you see something like "161/271" next to your name, that means PUBG knows about 271 squad games for you this season but our match cache only has 161 of them. This happens for anyone added to clan tracking partway through the season — PUBG's API only exposes a recent slice of matches per player, so games from before you were added can't be backfilled.

The stats shown are accurate for the games we captured. Your OVR isn't penalised for the gap; it's just computed from a smaller sample. The gap closes as you keep playing.

## A note on K/D vs. what you see in-game

Our K/D = kills ÷ losses, where losses = (captured games − wins). PUBG's in-client number counts every round you died — including matches your team won but you didn't survive — so our K/D tends to sit a notch higher than what PUBG shows you. Same methodology applied to every clan member, so the leaderboard is internally consistent even if a single player's number doesn't match their PUBG profile to the decimal.

## See your live rating

https://3pi.executiveundertakings.com
