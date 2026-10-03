import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grounds, groundsFor, snapToGrounds } from '../src/grounds.js';
import { normalizeFestival } from '../src/festivals.js';

test('every known grounds has a pin, a county, a source and a town, and a slug for an id', () => {
  for (const g of grounds()) {
    assert.match(g.id, /^[a-z0-9-]+$/, g.id); assert.ok(g.name && g.town && g.county && g.source, g.id);
    assert.ok(Number.isFinite(g.latitude) && Number.isFinite(g.longitude), g.id);
    assert.ok('verifiedOn' in g, `${g.id} says whether its pin was checked on a map`);
  }
});

test('a listing within a kilometer of known grounds, or within three when it names them, takes the grounds\' pin and facts', () => {
  const zilker = grounds().find(g => g.id === 'zilker-park');
  // A ticket site's pin for the park, 600 m east of it, at the box office.
  const near = { name: 'Austin City Limits Music Festival', location: 'Zilker Park, Austin, TX', latitude: 30.2669, longitude: -97.7667, startDate: '2026-10-02T16:00:00Z', endDate: '2026-10-05T05:00:00Z' };
  assert.equal(groundsFor(near)?.id, 'zilker-park');
  const s = snapToGrounds(near);
  assert.deepEqual([s.latitude, s.longitude, s.location, s.county, s.camping, s.indoor, s.grounds], [zilker.latitude, zilker.longitude, 'Zilker Park, Austin, TX', 'Travis County', false, false, 'zilker-park']);
  // A club 2.5 km away that names another place keeps its own pin; the same distance naming the park is the park.
  assert.equal(groundsFor({ ...near, location: "Stubb's Waller Creek Amphitheater, Austin, TX", latitude: 30.2687, longitude: -97.7470 }), null, 'two and a half kilometers, another name: its own place');
  assert.equal(groundsFor({ ...near, location: 'Zilker Park Great Lawn, Austin, TX', latitude: 30.2687, longitude: -97.7470 })?.id, 'zilker-park', 'two and a half kilometers, naming the park: the park');
  assert.equal(groundsFor({ ...near, latitude: 30.35, longitude: -97.7729 }), null, 'nine kilometers: nothing');
  // What the listing says stands: a camping pass on sale beats the grounds' default.
  assert.equal(snapToGrounds({ ...near, camping: true }).camping, true);
  assert.equal(snapToGrounds({ ...near, county: 'Hays County' }).county, 'Hays County', 'a county the listing names stands');
  const noPin = { ...near, latitude: NaN }; assert.equal(snapToGrounds(noPin), noPin, 'no pin, no snap');
  assert.equal(normalizeFestival(snapToGrounds(near)).festival.grounds, 'zilker-park', 'the grounds id survives normalizing');
});
