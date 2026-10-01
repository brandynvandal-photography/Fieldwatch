import test from 'node:test';
import assert from 'node:assert/strict';
import { ADD_ON, cleanName, coreName, sameCore, looksLikeFestival, normalizeName } from '../src/names.js';
import { inNwsArea, normalizeFestival, sameFestival } from '../src/festivals.js';

// Names as the first live import printed them.
const CLEAN = [
  ['Rock The South - 4 Day Pass - with Jason Aldean, Riley Green, Zach Top and more (Rescheduled from 06/11-06/13)', 'Rock The South'],
  ['Rock The South - Thursday - with Zach Top (Rescheduled from 06/11/26)', 'Rock The South'],
  ['Yours Always Music Festival - 2 Day Pass - with Benson Boone, Sombr, Labrinth and more', 'Yours Always Music Festival'],
  ['Breakaway Music Festival Houston - Friday (18+)', 'Breakaway Music Festival Houston'],
  ['Day Trip Festival (18+) - NorCal - 2 Day Pass - with Gordo B2B Vintage Culture, Cloonee, Chris Lorenzo, and more', 'Day Trip Festival - NorCal'],
  ['Holo Holo Music Festival - Avila Beach - with Common Kings, Iam Tongi, Mike Love, and more', 'Holo Holo Music Festival - Avila Beach'],
  ['Lil Baby: Upstate Fest Feat. Fetty Wap, Key Glock, Boosie, & KenTheMan', 'Lil Baby: Upstate Fest'],
  ['2-Day Palm Tree Music Festival', 'Palm Tree Music Festival'], ['Palm Tree Music Festival - FRI 10/2', 'Palm Tree Music Festival'],
  ['Mission Bayfest 3 DAYS', 'Mission Bayfest'], ['Mission Bayfest Friday 10/16/2026', 'Mission Bayfest'],
  ['Starstuff: A Festival of Solo Artists (Odyssey 3 Day Pass)', 'Starstuff: A Festival of Solo Artists'],
  ['Lights All Night Dance Festival: 2 Day Pass (18+ Event)', 'Lights All Night Dance Festival'],
  ['Faultline Festival 2-Day Pass', 'Faultline Festival'], ['Faultline Festival with Bush', 'Faultline Festival'],
  ['Good Moon Festival VIP Weekend Pass', 'Good Moon Festival'],
  ['Decibel - Metal & Beer Festival: 3-DAY PASS (Pre-Fest at Ratio)', 'Decibel - Metal & Beer Festival'],
  ['Decibel - Metal & Beer Festival: Day 1 Pass (12-04)', 'Decibel - Metal & Beer Festival'],
  ['ShoalsFest - Saturday Pass- with Jason Isbell & The 400 Unit, S.G. Goodman, Steve Trash and more', 'ShoalsFest'],
  ['Winstock Country Music Festival - Friday Pass- with Tucker Wetmore', 'Winstock Country Music Festival'],
  ['Decadence Denver - Night 1 (18+)', 'Decadence Denver'], ['Decadence Arizona - Day 1 (18+)', 'Decadence Arizona'],
  ['TO THE FUTURE: NYE 2026 - 2 Day pass (21+) - with GRiZ, Tape B, TroyBoi, and more', 'TO THE FUTURE: NYE'],
  ['Proper NYE/NYD - Friday (21+)', 'Proper NYE/NYD'], ['Freaky Deaky - Friday (18+)', 'Freaky Deaky'],
  ['Sun, Sand and Soul Festival - 3 Day Pass - With Tedeschi Trucks Band, Earth, Wind, and Fire, Lukas Nelson, and more', 'Sun, Sand and Soul Festival'],
  ['Party in the Park Tucson with Wiz Khalifa, DaBaby, Waka Flocka Flame, and more', 'Party in the Park Tucson'],
  ['Fall Fest with Amy Grant and Mac McAnally', 'Fall Fest'], ['Winter Fest Featuring Webbie', 'Winter Fest'],
  ["Nashville Jazz Festival featuring 'SUPER NOVA' featuring  Jeff Coffin ,  Bill Evans &  Keith Carlock", 'Nashville Jazz Festival'],
  ['Tacos and Tequila Festival (21 and Over with a valid physical photo ID)', 'Tacos and Tequila Festival'],
  ['12th Annual CoreyFest with Brothers Osborne (21+)', '12th Annual CoreyFest'],
  ['Boots In The Park - Orange County - with Jon Pardi, Jackson Dean, and more', 'Boots In The Park - Orange County'],
  ['Los Lonely Boys: Rockpango Fest 2026 - canceled', 'Los Lonely Boys: Rockpango Fest'],
  ['Suwannee Hulaween', 'Suwannee Hulaween'], ['Austin City Limits, Weekend 1', 'Austin City Limits, Weekend 1'], ['Sick New World Texas', 'Sick New World Texas'],
  ['Vans Warped Tour Orlando', 'Vans Warped Tour Orlando'], ['Aftershock - Friday', 'Aftershock'], ['Aftershock 3 Day Pass', 'Aftershock'], ['  ', ''],
  ['Winnetka Music Festival 2027', 'Winnetka Music Festival'], ['2027 CMA Fest presented by SoFi', 'CMA Fest'], ['K-ERA Fest 2026: TAEMIN', 'K-ERA Fest: TAEMIN'],
  ['Iron Fest XVII Night One', 'Iron Fest XVII'], ['Decadence Denver - Night Two', 'Decadence Denver'], ['Magnolia Park - Halloween Fest presented by WJRR', 'Magnolia Park - Halloween Fest'],
  ['Voltaege Fest 2026, Kept on Hold, WIPEOUT, Follow The Protocol, Nicole Alexis, When The Sun Sets, Vampire Cowgirl', 'Voltaege Fest'],
  ['Depeche Mode, Bauhaus, The Cure, Siouxie & The Banshees, Joy Divsion Tributes - Dark Wave Festival', 'Depeche Mode, Bauhaus, The Cure, Siouxie & The Banshees, Joy Divsion Tributes - Dark Wave Festival'],
];

test('a listing name comes down to the festival: no day, pass, lineup, age note, status or year', () => {
  for (const [raw, want] of CLEAN) assert.equal(cleanName(raw), want, raw);
  assert.equal(normalizeName('Aftershock - Friday'), normalizeName('Aftershock 3 Day Pass'), 'so the two listings share a key');
});

test('the core of a name is what makes it its own, so the same festival named twice is caught', () => {
  assert.equal(coreName('Country Calling Festival'), 'country calling');
  assert.equal(coreName('12th Annual CoreyFest with Brothers Osborne'), 'coreyfest');
  for (const [a, b, want] of [['Breakaway Utah', 'Breakaway Music Festival', true], ['Country Calling', 'Country Calling Festival', true],
    ['Carolina Country Music Fest', 'Carolina Country Music Festival', true], ['Lights All Night Dance Festival', 'Lights All Night Festival', true],
    ['Country In The Park 2', 'Country In The Park', true], ['Reggae Fest', 'Haunted Fest', false], ['Suwannee Hulaween', 'Suwannee Roots Revival', false], ['', 'Fest', false]]) {
    assert.equal(sameCore(a, b), want, `${a} | ${b}`);
  }
});

test('a nickname is the same core: the initials of the name, or the front of its first word', () => {
  for (const [a, b, want] of [['ACL Fest', 'Austin City Limits, Weekend 1', true], ['Austin City Limits Music Festival', 'ACL Fest Late Night Show: Khruangbin', true],
    ['LIB', 'Lightning in a Bottle', true], ['EDC Las Vegas', 'Electric Daisy Carnival', true], ['Lolla Aftershow', 'Lollapalooza', true], ['Summer Fest', 'Summerfest', true],
    ['ABC Fest', 'Austin City Limits', false], ['Austin Reggae Fest', 'ACL Fest', false], ['Roo', 'Bonnaroo', false], ['Rock the Bells', 'RTB', false]]) {
    assert.equal(sameCore(a, b), want, `${a} | ${b}`);
  }
});

test('a late-night show or an aftershow sold under a festival\'s name is an add-on, like parking', () => {
  for (const [n, want] of [['ACL Fest: Late Night with Khruangbin', true], ['Lollapalooza Aftershow: Artist', true], ['Bonnaroo Late-Night', true], ['ACL Fest Nights: Artist', true],
    ['Electric Forest Parking', true], ['Suwannee Hulaween', false], ['Lights All Night Festival', false], ['Moonrise Fest - Saturday', false]]) assert.equal(ADD_ON.test(n), want, n);
});

test('a name that says festival, and not a tour, tribute or concert unless it also says fest', () => {
  for (const [n, want] of [['Tracy Byrd', false], ['Morrissey - Live in Concert', false], ['The Concert: A Tribute To ABBA', false], ['Latin Grammy Awards', false],
    ['MOVEMENTS - HAPPIER NOW USA TOUR', false], ['Halloween Bash', false], ['Fort Collins Symphony - Signature Concert 1', false],
    ['Michigan Renaissance Festival', true], ['Dark Star Jubilee', true], ['Red Steagall Cowboy Gathering', true], ['Tom Petty Weekend', true],
    ['Wurst Fest', true], ['Sun BrewFest', true], ['Cotton and Crude Fest', true], ['Rocktoberfest', true], ['Levitate Flannel Jam', true], ['Matisyahu - Festival of Lights', true],
    ['Gregory Porter - DC Jazz Festival Benefit Concert', false], ['Matisyahu - Festival of Lights Tour', false], ["Hawaii's Finest Presents High Watah", false],
    ["Joey's Song Presents The Freezing Man Festival", true], ['Midori & Festival Strings Lucerne Perform Tchaikovsky\'s Violin Concerto', false], ['Latin Grammy Awards', false]]) assert.equal(looksLikeFestival(n), want, n);
});

test('festivals outside the weather service area are refused everywhere: no alerts are possible there', () => {
  for (const [lat, lon, want] of [[30.4, -82.9, true], [61.2, -149.9, true], [21.3, -157.8, true], [18.4, -66.1, true], [13.5, 144.8, true],
    [19.40345, -99.08878, false], [18.47835, -69.91688, false], [51.5, -0.1, false], [-33.9, 151.2, false]]) assert.equal(inNwsArea(lat, lon), want, `${lat},${lon}`);
  const mx = normalizeFestival({ name: 'Corona Capital', location: 'Autódromo Hermanos Rodríguez, Temple City, CA', latitude: 19.40345, longitude: -99.08878, startDate: '2026-11-20', endDate: '2026-11-22' });
  assert.match(mx.error, /outside the National Weather Service area/);
  assert.ok(normalizeFestival({ name: 'Aftershock', location: 'Sacramento, CA', latitude: 38.6, longitude: -121.5, startDate: '2026-10-01', endDate: '2026-10-04' }).festival);
});

test('the same festival from two sources: same grounds, or the same name within the sprawl of one', () => {
  const tm = { name: 'Country Calling', latitude: 38.37791, longitude: -75.06907, startDate: '2026-10-02T16:00:00Z', endDate: '2026-10-04T08:00:00Z' };
  const sg = { name: 'Country Calling Festival', latitude: 38.3377, longitude: -75.0816, startDate: '2026-10-02T16:00:00Z', endDate: '2026-10-03T17:00:00Z' };
  assert.equal(sameFestival(tm, sg), true, 'four kilometers apart, one name');
  assert.equal(sameFestival(tm, { ...sg, name: 'Boardwalk Reggae Fest' }), false, 'four kilometers apart, another name');
  assert.equal(sameFestival(tm, { ...sg, startDate: '2026-11-02T16:00:00Z', endDate: '2026-11-03T17:00:00Z' }), false, 'a month apart');
  assert.equal(sameFestival(tm, { ...sg, name: 'Ocean City Bluegrass', latitude: 38.378, longitude: -75.069 }), true, 'same grounds, any name');
  // A side show across town under the festival's initials: Stubb's is 3.5 km from Zilker Park.
  const zilker = { name: 'Austin City Limits, Weekend 1', latitude: 30.2669, longitude: -97.7729, startDate: '2026-10-02T16:00:00Z', endDate: '2026-10-05T05:00:00Z' };
  const stubbs = { name: 'ACL Fest', latitude: 30.2687, longitude: -97.7362, startDate: '2026-10-02T23:00:00Z', endDate: '2026-10-04T06:00:00Z' };
  assert.equal(sameFestival(zilker, stubbs), true, 'ACL Fest at Stubb\'s the same weekend is Austin City Limits');
  assert.equal(sameFestival(zilker, { ...stubbs, latitude: 30.35 }), false, 'ten kilometers out is past the sprawl of one set of grounds');
});
