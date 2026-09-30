// Shapes from the Wikidata SPARQL endpoint (application/sparql-results+json) and the festival
// homepages the importer reads, reduced to what it looks at.
const lit = (value, extra = {}) => ({ type: 'literal', value, ...extra });
export const wdItem = ({ qid, label, lat, lon, website, venue, admin }) => ({
  item: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
  ...(label !== undefined ? { itemLabel: lit(label, { 'xml:lang': 'en' }) } : {}),
  coord: lit(`Point(${lon} ${lat})`, { datatype: 'http://www.opengis.net/ont/geosparql#wktLiteral' }),
  ...(website ? { website: { type: 'uri', value: website } } : {}),
  ...(venue ? { venueLabel: lit(venue, { 'xml:lang': 'en' }) } : {}),
  ...(admin ? { adminLabel: lit(admin, { 'xml:lang': 'en' }) } : {}),
});
export const sparqlResult = bindings => ({ head: { vars: ['item', 'itemLabel', 'coord', 'website', 'venueLabel', 'adminLabel'] }, results: { bindings } });

// Five items the query would return (a dissolved one never reaches us; the query filters P576 out).
export const items = [
  wdItem({ qid: 'Q9001', label: 'Dry Creek Bluegrass Festival', lat: 38.93, lon: -120.02, venue: 'Dry Creek Ranch', admin: 'Placerville' }),        // no website: nowhere to read dates from
  wdItem({ qid: 'Q9002', label: 'Salt Flats Sound', lat: 40.74, lon: -113.85, website: 'https://saltflatssound.example/', admin: 'Wendover' }),          // a site with no JSON-LD
  wdItem({ qid: 'Q9003', label: 'Moonrise Fest', lat: 35.49, lon: -93.83, website: 'https://moonrisefest.example', venue: 'Mulberry Mountain', admin: 'Ozark' }),   // @graph with per-day MusicEvents; Wikidata has the town, the page has the grounds 24 km away
  wdItem({ qid: 'Q9004', label: 'Big Sky Jam', lat: 46.87, lon: -113.99, website: 'https://bigskyjam.example/', venue: 'Riverfront Park', admin: 'Missoula' }),      // a Festival more than a year out
  wdItem({ qid: 'Q9005', label: 'Hidden Hollow', lat: 36.91, lon: -80.32, website: 'https://hiddenhollow.example/', venue: 'Hollow Farm', admin: 'Floyd' }),         // robots.txt says no
];
// Curated already: same grounds, same dates as data/festivals.json's Suwannee Hulaween. The page's geo is nowhere near, so Wikidata's coordinates count.
export const hulaween = wdItem({ qid: 'Q9006', label: 'Suwannee Hulaween', lat: 30.4045, lon: -82.939, website: 'https://hulaween.example/', venue: 'Spirit of the Suwannee Music Park', admin: 'Live Oak' });

const page = (title, blocks) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>\n${blocks.map(b => `<script type="application/ld+json">\n${typeof b === 'string' ? b : JSON.stringify(b, null, 1)}\n</script>`).join('\n')}\n</head><body><h1>${title}</h1><script>window.x = 1</script></body></html>`;
const mulberry = { '@type': 'Place', name: 'Mulberry Mountain', geo: { '@type': 'GeoCoordinates', latitude: '35.6981', longitude: '-93.7793' }, address: { '@type': 'PostalAddress', addressLocality: 'Ozark', addressRegion: 'AR' } };

export const pages = {
  'https://saltflatssound.example/': page('Salt Flats Sound', [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Salt Flats Sound', url: 'https://saltflatssound.example/' }]),
  'https://moonrisefest.example/': page('Moonrise Fest', [
    { '@context': 'https://schema.org', '@graph': [
      { '@type': 'Organization', name: 'Moonrise Presents' },
      { '@type': 'MusicEvent', name: 'Moonrise Fest - Friday', startDate: '2026-10-09T17:00:00-05:00', location: mulberry },
      { '@type': 'MusicEvent', name: 'Moonrise Fest - Saturday', startDate: '2026-10-10', location: mulberry },
      { '@type': ['MusicEvent', 'Event'], name: 'Moonrise Fest - Sunday', startDate: '2026-10-11', endDate: '2026-10-11', location: [mulberry] },
      { '@type': 'MusicEvent', name: 'Moonrise Fest 2025', startDate: '2025-10-10', endDate: '2025-10-12', location: mulberry },   // last year's block, still on the page
      { '@type': 'MusicEvent', name: 'Moonrise Silent Disco', startDate: '2026-10-10', eventStatus: 'https://schema.org/EventCancelled', location: mulberry },
    ] },
    '{ this is not json',
  ]),
  'https://bigskyjam.example/': page('Big Sky Jam', [{ '@context': 'https://schema.org', '@type': 'Festival', name: 'Big Sky Jam 2027', startDate: '2027-11-12', endDate: '2027-11-14', location: { '@type': 'Place', name: 'Riverfront Park' } }]),
  'https://hiddenhollow.example/': page('Hidden Hollow', [{ '@context': 'https://schema.org', '@type': 'Festival', name: 'Hidden Hollow', startDate: '2026-10-17', endDate: '2026-10-18' }]),
  'https://hulaween.example/': page('Suwannee Hulaween', [{ '@context': 'https://schema.org', '@type': 'https://schema.org/Festival', name: 'Suwannee Hulaween 2026', startDate: '2026-10-22', endDate: '2026-10-25',
    location: { '@type': 'Place', name: 'Somewhere else entirely', geo: { '@type': 'GeoCoordinates', latitude: 40.0, longitude: -100.0 } } }]),
};

export const robots = {
  'https://hiddenhollow.example/robots.txt': 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n',
  'https://moonrisefest.example/robots.txt': '# be nice\nUser-agent: *\nDisallow: /admin/\nDisallow: /cart\nSitemap: https://moonrisefest.example/sitemap.xml\n',
};
