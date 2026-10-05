// Trimmed but shape-faithful api.weather.gov responses, so the tests never touch the network.

export const alertFeature = (overrides = {}) => ({
  id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa',
  type: 'Feature',
  geometry: null,
  properties: {
    '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.aaa',
    '@type': 'wx:Alert',
    id: 'urn:oid:2.49.0.1.840.0.aaa',
    areaDesc: 'Suwannee; Columbia',
    sent: '2026-10-23T14:02:00-04:00',
    effective: '2026-10-23T14:02:00-04:00',
    onset: '2026-10-23T14:02:00-04:00',
    expires: '2026-10-23T15:00:00-04:00',
    ends: '2026-10-23T15:00:00-04:00',
    status: 'Actual', messageType: 'Alert', category: 'Met',
    severity: 'Severe', certainty: 'Observed', urgency: 'Immediate',
    event: 'Severe Thunderstorm Warning',
    sender: 'w-nws.webmaster@noaa.gov',
    senderName: 'NWS Jacksonville FL',
    headline: 'Severe Thunderstorm Warning issued October 23 at 2:02PM EDT until October 23 at 3:00PM EDT by NWS Jacksonville FL',
    description: 'At 202 PM EDT, a severe thunderstorm was located near Live Oak, moving northeast at 30 mph.',
    instruction: 'For your protection move to an interior room on the lowest floor of a building.',
    response: 'Shelter',
    parameters: {},
    ...overrides,
  },
});

export const points = {
  properties: {
    '@id': 'https://api.weather.gov/points/30.404,-82.9395',
    gridId: 'JAX', gridX: 40, gridY: 90,
    forecast: 'https://api.weather.gov/gridpoints/JAX/40,90/forecast',
    forecastHourly: 'https://api.weather.gov/gridpoints/JAX/40,90/forecast/hourly',
    forecastGridData: 'https://api.weather.gov/gridpoints/JAX/40,90',
    county: 'https://api.weather.gov/zones/county/FLC121', forecastZone: 'https://api.weather.gov/zones/forecast/FLZ024',
    timeZone: 'America/New_York',
  },
};

export const hourly = {
  properties: {
    updated: '2026-10-23T13:30:00+00:00',
    periods: Array.from({ length: 48 }, (_, n) => ({
      number: n + 1,
      name: '',
      startTime: new Date(Date.UTC(2026, 9, 23, 18 + n)).toISOString().replace('.000Z', '-00:00'),
      endTime: new Date(Date.UTC(2026, 9, 23, 19 + n)).toISOString().replace('.000Z', '-00:00'),
      isDaytime: n < 6,
      temperature: 84 - n,
      temperatureUnit: 'F',
      probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: n % 3 === 0 ? null : 40 },
      windSpeed: '10 mph',
      windDirection: 'SW',
      icon: 'https://api.weather.gov/icons/land/day/tsra,40?size=small',
      shortForecast: 'Chance Showers And Thunderstorms',
      detailedForecast: '',
    })),
  },
};

// The raw grid behind the forecasts (/gridpoints/{wfo}/{x},{y}): values carry an ISO interval with a duration,
// in metric units. Hours 0-47 from the same 18:00Z start as `hourly`. Heat index peaks at 96 F around hour 3,
// gusts at 34 mph around hour 5, thunder at 60% at hours 6-7, a tenth of an inch of rain over hours 0-5 and half an inch over hours 6-11.
const gridTime = (h, dur = 'PT1H') => `${new Date(Date.UTC(2026, 9, 23, 18 + h)).toISOString().replace('.000Z', '+00:00')}/${dur}`;
const fToC = f => Math.round((f - 32) * 5 / 9 * 100) / 100;
export const grid = {
  properties: {
    '@id': 'https://api.weather.gov/gridpoints/JAX/40,90',
    updateTime: '2026-10-23T13:30:00+00:00',
    heatIndex: { uom: 'wmoUnit:degC', values: [
      { validTime: gridTime(0), value: fToC(91) }, { validTime: gridTime(1, 'PT2H'), value: fToC(94) }, { validTime: gridTime(3), value: fToC(96) },
      { validTime: gridTime(4), value: fToC(92) }, { validTime: gridTime(5, 'PT3H'), value: fToC(86) }, { validTime: gridTime(8, 'PT4H'), value: null },
    ] },
    windGust: { uom: 'wmoUnit:km_h-1', values: [
      { validTime: gridTime(0, 'PT2H'), value: 24.14 }, { validTime: gridTime(2, 'PT2H'), value: 40.23 }, { validTime: gridTime(4), value: 48.28 },
      { validTime: gridTime(5), value: 54.72 }, { validTime: gridTime(6, 'PT6H'), value: 32.19 }, { validTime: gridTime(12, 'P1DT12H'), value: 16.09 },
    ] },
    quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [
      { validTime: gridTime(0, 'PT6H'), value: 2.54 }, { validTime: gridTime(6, 'PT6H'), value: 12.7 }, { validTime: gridTime(12, 'P1DT6H'), value: 0 },
    ] },
    // Air temperature, humidity, wind and cloud behind the heat estimate: a warm, humid, cloudy evening, green flag.
    temperature: { uom: 'wmoUnit:degC', values: Array.from({ length: 12 }, (_, h) => ({ validTime: gridTime(h), value: fToC(84 - h) })) },
    relativeHumidity: { uom: 'wmoUnit:percent', values: [{ validTime: gridTime(0, 'PT12H'), value: 65 }] },
    windSpeed: { uom: 'wmoUnit:km_h-1', values: [{ validTime: gridTime(0, 'PT12H'), value: 16.09 }] },
    skyCover: { uom: 'wmoUnit:percent', values: [{ validTime: gridTime(0, 'PT12H'), value: 70 }] },
    windDirection: { uom: 'wmoUnit:degree_(angle)', values: [{ validTime: gridTime(0, 'PT12H'), value: 225 }] },
    apparentTemperature: { uom: 'wmoUnit:degC', values: Array.from({ length: 12 }, (_, h) => ({ validTime: gridTime(h), value: fToC(82 - h) })) },
    probabilityOfThunder: { uom: 'wmoUnit:percent', values: [
      { validTime: gridTime(0, 'PT3H'), value: 20 }, { validTime: gridTime(3, 'PT3H'), value: 40 }, { validTime: gridTime(6, 'PT2H'), value: 60 },
      { validTime: gridTime(8, 'PT4H'), value: 30 }, { validTime: gridTime(12, 'P1DT12H'), value: 0 },
    ] },
  },
};

// The 7-day forecast (/gridpoints/{wfo}/{x},{y}/forecast): a period per day and per night.
const dayAt = n => new Date(Date.UTC(2026, 9, 23 + n, 10));   // 6 AM Eastern
export const daily = {
  properties: {
    updated: '2026-10-23T13:30:00+00:00',
    periods: Array.from({ length: 14 }, (_, i) => {
      const n = Math.floor(i / 2), day = i % 2 === 0, start = new Date(dayAt(n).getTime() + (day ? 0 : 12 * 3600000));
      const names = ['Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
      const highs = [88, 79, 74, 76, 78, 80, 81], lows = [66, 58, 44, 47, 52, 55, 57], rain = [40, 70, 20, 0, 10, 0, 0];
      return {
        number: i + 1, name: i === 0 ? 'Today' : i === 1 ? 'Tonight' : day ? names[n] : `${names[n]} Night`,
        startTime: start.toISOString().replace('.000Z', '-04:00'), endTime: new Date(start.getTime() + 12 * 3600000).toISOString().replace('.000Z', '-04:00'),
        isDaytime: day, temperature: day ? highs[n] : lows[n], temperatureUnit: 'F',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: day ? rain[n] : Math.max(0, rain[n] - 20) || null },
        windSpeed: n === 1 ? '15 to 25 mph' : '5 to 10 mph', windDirection: 'SW',
        shortForecast: rain[n] >= 60 ? 'Showers And Thunderstorms Likely' : rain[n] >= 30 ? 'Chance Showers' : day ? 'Sunny' : 'Clear',
        detailedForecast: '',
      };
    }),
  },
};
