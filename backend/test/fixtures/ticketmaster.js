// Shapes from the Ticketmaster Discovery API v2 (events.json), reduced to the fields the importer reads.
let n = 0;
export const tmVenue = (over = {}) => ({ id: 'KovZpZAEkn6A', name: 'Mulberry Mountain', city: { name: 'Ozark' }, state: { stateCode: 'AR' },
  location: { latitude: '35.6981', longitude: '-93.7793' }, ...over });
export const tmEvent = (over = {}) => ({
  id: `vvG1${String(++n).padStart(6, '0')}`, name: 'Moonrise Fest - Friday', url: 'https://www.ticketmaster.com/moonrise-fest-friday/event/1',
  test: false, dates: { start: { localDate: '2026-10-09', dateTime: '2026-10-09T17:00:00Z' } },
  classifications: [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Rock' }, type: { name: 'Undefined' }, subType: { name: 'Undefined' } }],
  _embedded: { venues: [tmVenue()], attractions: [{ name: 'Someone' }] },
  ...over,
});
export const tmPage = (events, { page = 0, totalPages = events.length ? 1 : 0 } = {}) =>
  ({ _embedded: events.length ? { events } : undefined, page: { size: 200, totalElements: events.length, totalPages, number: page } });
