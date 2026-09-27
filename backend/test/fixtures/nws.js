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
