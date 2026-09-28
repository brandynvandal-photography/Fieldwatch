// Shapes from the SeatGeek Platform API (/2/events), reduced to the fields the importer reads.
let n = 0;
export const sgVenue = (over = {}) => ({ id: 4100, name: 'Mulberry Mountain', city: 'Ozark', state: 'AR', country: 'US', location: { lat: 35.6981, lon: -93.7793 }, timezone: 'America/Chicago', ...over });
export const sgEvent = (over = {}) => ({
  id: 6000000 + (++n), type: 'music_festival', title: 'Moonrise Fest - Friday', short_title: 'Moonrise Fest - Friday',
  url: 'https://seatgeek.com/moonrise-fest-friday-tickets/1', datetime_utc: '2026-10-09T17:00:00', datetime_local: '2026-10-09T12:00:00',
  datetime_tbd: false, time_tbd: false, date_tbd: false, enddatetime_utc: null,
  taxonomies: [{ id: 2000000, name: 'concert', parent_id: null }, { id: 2010000, name: 'music_festival', parent_id: 2000000 }],
  performers: [{ name: 'Someone', primary: true }], venue: sgVenue(),
  ...over,
});
export const sgPage = (events, { page = 1, total = events.length, perPage = 100 } = {}) => ({ events, meta: { total, took: 3, page, per_page: perPage, geolocation: null } });
