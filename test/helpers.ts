import type { Offer, WatchSpec } from '../src/core/types.ts';

export function spec(over: Partial<WatchSpec> = {}): WatchSpec {
  return {
    origins: ['MOW'],
    destinations: ['IST'],
    tripType: 'roundtrip',
    departFrom: '2026-11-15',
    departTo: '2026-11-30',
    nightsMin: 6,
    nightsMax: 9,
    returnTo: null,
    departWeekdays: null,
    returnWeekdays: null,
    directOnly: false,
    maxTransfers: null,
    maxDurationMin: null,
    excludeAirlines: null,
    departTimeFrom: null,
    departTimeTo: null,
    adults: 1,
    priceMode: 'threshold',
    maxPrice: 10000,
    autoSensitivity: 0.2,
    ...over,
  };
}

export function offer(over: Partial<Offer> = {}): Offer {
  return {
    originAirport: 'SVO',
    destAirport: 'IST',
    departAt: '2026-11-18T06:40:00+03:00',
    returnAt: '2026-11-25T18:20:00+03:00',
    price: 8450,
    currency: 'rub',
    airline: 'PC',
    flightNumber: '395',
    transfersOut: 1,
    transfersBack: 0,
    durationMin: 600,
    durationOutMin: 360,
    durationBackMin: 240,
    link: '/search/SVO1811IST25111?t=PC_abc&search_date=28092026&expected_price_uuid=x',
    foundAt: null,
    expiresAt: null,
    ...over,
  };
}

/** Строка в формате prices_for_dates из документации Travelpayouts. */
export function rawItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origin: 'MOW',
    destination: 'IST',
    origin_airport: 'SVO',
    destination_airport: 'IST',
    price: 8450,
    airline: 'PC',
    flight_number: '395',
    departure_at: '2026-11-18T06:40:00+03:00',
    return_at: '2026-11-25T18:20:00+03:00',
    transfers: 1,
    return_transfers: 0,
    duration: 600,
    duration_to: 360,
    duration_back: 240,
    link: '/search/SVO1811IST25111?t=PC17634...&search_date=28092026&expected_price_uuid=7531ddb1&expected_price_currency=rub',
    ...over,
  };
}
