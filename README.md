# MERCY ARENA

MERCY ARENA — турнирная платформа для Mobile Legends: Bang Bang.

## Public frontend

The static frontend is published with GitHub Pages:

- https://raeffsky.github.io/MERCY-ARENA/

Current public sections:
- Home dashboard
- Tournaments
- Teams
- Players
- Match center and brackets
- Rankings
- Seasons
- Auto Result Engine status and validation flow
- Organizer hub
- About the platform

All sections use separate hash routes. The interface is responsive and uses the approved MERCY ARENA visual system.

## Data integrity

No demo tournaments, teams, players, schedules, scores, or rankings are inserted. Empty states are intentional until a trusted backend is connected.

The Auto Result Engine is not active yet. The frontend does not claim to retrieve live MLBB match results. See [Backend integration contract](docs/BACKEND-INTEGRATION.md) for the required API, validation flow, security rules, and data model.

## Brand

- Background: `#08090D`
- Primary accent: `#D7FF5E`
- Text: `#F5F6FA`
- Secondary accent: `#6D78FF`
- Brand mark: `public/assets/brand/mercy-mark.png`
- Vector mark: `public/assets/brand/mercy-mark.svg`

Icons use Iconify. Typography uses Barlow Condensed and Manrope.
