// Shapes from the Edmtrain API (/api/events), reduced to the fields the importer reads.
let n = 0;
export const edmVenue = (over = {}) => ({ id: 900, name: 'Discovery Park', location: 'Sacramento, CA', address: '1600 Garden Hwy', state: 'California', latitude: 38.6006, longitude: -121.5093, ...over });
export const edmEvent = (over = {}) => ({
  id: 700000 + (++n), link: 'https://edmtrain.com/sacramento?event=700001', name: 'Beyond Wonderland Sacramento', ages: '18+', festivalInd: true, livestreamInd: false,
  electronicGenreInd: true, otherGenreInd: false, date: '2026-11-07', startTime: '2026-11-07T14:00:00', endTime: null, createdDate: '2026-06-01T00:00:00',
  venue: edmVenue(), artistList: [{ id: 1, name: 'Someone', link: 'https://edmtrain.com/artist/1', b2bInd: false }],
  ...over,
});
export const edmBody = (data, over = {}) => ({ success: true, message: '', data, ...over });
