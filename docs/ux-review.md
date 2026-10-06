# UI and UX review, 2026-10-05

A pass over every screen of the web build at phone size, light and dark, from the test suite's screenshots and the field rules in `CLAUDE.md` (panic first, only what matters on screen, one loud element per screen, sun and one hand). Ranked by what it does for someone standing in a field with a warning on the sky. Nothing here is built yet.

## Fix now: cheap, and the panic case gets better

1. **A warning layout for the festival page.** Today the header (dates, a two-line name, a two-line venue) takes the top third, so a red card starts a third of the way down and the line to act on sits at the middle of the screen. When the sky is red or a hold stands: the name on one line, the venue dropped, the six-hour strip hidden (nobody needs 4 PM's temperature during a warning), the orbs at two thirds of their size, and the card's foot says "Until 3:00 PM" instead of "Checked just now". The big header comes back on green. One loud element, and it is on the first screen without a scroll.
2. **No tour over a live warning.** The first-visit tour starts on the first festival page even when that page is red ("Green means you're fine. If it turns red..." over a red card). Defer the tour until the sky is green or watch; never coach during a warning.
3. **Toasts out of the way.** "Finding where you are", "Saved", "Thanks. Reported: mud" sit over the bottom of the screen, where the primary buttons are (the Favorite ask, Send, Share). Move toasts under the topbar, and drop the "Finding where you are" toast for a spinner on the location row.
4. **The favorite ask waits.** The "Favorite Suwannee Hulaween?" card appears under the orbs on the first visit, warning or not. Hide it while the sky is red; ask on the next green open.
5. **"Favorite" is the wrong word.** On a safety app a heart reads as a social feature. The row already says what it does ("Its warnings on this phone, even when the app is closed"), and the spot's own row is called "Warnings on this phone". Call both "Warnings on this phone", keep the heart as the icon, and the ask becomes "Get its warnings on this phone?".
6. **Radar labels.** At the 160 km scale the 8 mi label sits under the 12 mi one, and the pin label ("Suwannee Hulaween", 22 px) covers the south half of the 20 mi ring, which is where the storms usually come from. Stagger the ring labels (8 below, 12 above, 20 above right), and shrink the pin label to 12 px or drop it (the page title already names the festival).
7. **Alert screen order and words.** The share button ("Warn people near you") is the stronger action in a warning; put it right under the two lines, and the thunder clock under it as a quieter row. "18 d left" is noise: show "left" only inside six hours, else "Until Fri 3:00 PM". "Full alert" has a right chevron but opens in place: rotate the chevron when open. Label the weather service's own instruction "The weather service says" so it does not read as a second, different "What to do".
8. **Muted text contrast.** `--muted` (#6F6A8F) on the light glass is about 4:1; a step darker (#5A5580) passes 5:1 without changing the look. Dark mode is fine.

## Next: bigger, still worth it

9. **Radar closer in.** The square is 320 km across, so the 20 mi ring is a fifth of it. A second scale (60 km) as a toggle on the square, with the rings and the flashes at that scale, shows the rain that matters in the next hour. The backend caches frames for one square per festival, so the close square comes from the archive directly, like the no-backend path, or the backend adds a second square per festival that is on.
10. **The radar screen in one screen.** The title block above the square (eyebrow, "Radar", the sub line) costs 150 px, so the scrubber falls below the fold on a small phone. One line ("Radar · last 12 h · 160 km") above the square.
11. **The weather screen says the hours once.** The 24-hour chart and the hour cards carry the same temperatures and the same rain chances; the cards are four to a screen. Make the cards a compact strip (the sky card's strip, scrollable, 24 wide) under the chart, or drop them and give the chart a tap-to-read.
12. **Prep deadlines.** Four steps "by 5:35, 5:40, 5:40, 5:45" read as fake precision. One deadline for the block ("all of this by 5:35 PM, in this order"), and a time per step only when the steps are fifteen minutes or more apart.
13. **Lightning screen for the person, then the staff.** Each code row shows the protocol paragraph ("Non-essential personnel should prioritize exit...") before the line for you. Show the "you" line first and fold the protocol under "For staff".
14. **Search at the top of a long list.** (Moot since 2026-10-06: the search is gone; the whole list is behind the Festivals tile.) On the festivals list, "Search festivals" and "Right where you are" sit at the bottom, past every bubble. When the list is longer than eight, put the search row first.
15. **Pull to refresh.** Phones expect it on the festival page and the list; the refresh button stays for the desktop.
16. **The topbar is crowded.** Five round buttons at 390 px (Festivals, heart, share, refresh, gear). Move the heart and the share into the page's rows (both already have a row or a screen), leaving Festivals, refresh and the gear, and the title gets its width back.

## Taste calls, your decision

17. **The warning title in the sans.** The serif display face is beautiful on page titles, but the one line that matters in a panic, "Severe Thunderstorm Warning" at 44 px white on red, is slower to read than a heavy sans, and wraps to two lines. The sky card's event name in the sans at 28 px bold, the serif kept for page titles.
18. **The walkthrough is long.** Cover, three pages, a start page, then a four-step tour: eight steps before the app. The intro scene plus two pages (the sky card, the code) and a two-step tour would teach the same.
19. **Section headers twice.** "FORECAST" over a card titled "NEXT 24 HOURS", "HEAT, WIND, LIGHTNING" over three titled panels. One or the other.
