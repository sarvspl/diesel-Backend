/**
 * Flow-meter / bowser provider — the port the application depends on.
 *
 * Callers ask one question: "what does the tanker read, right now?" for a
 * vehicle. The concrete provider (a mock in development, the dezel4u/FYFT
 * adapter in production) answers with a reading in OUR shape. The vendor's wire
 * format is mapped inside the adapter and never leaks past it — as the OTP
 * provider hides its SMS vendor (docs/16, ADR-011).
 *
 * TWO MEASUREMENT MODELS. A custody-transfer meter reports a lifetime
 * `TOTALIZER` (litres ever dispensed), where delivered = end − start. The
 * dezel4u platform reports current tank `STOCK` (litres in the bowser now),
 * where delivered = start − end. The reading carries which model it is so the
 * delivery calculation can branch correctly; conflating them would invert every
 * delivered quantity.
 *
 * Numeric values are STRINGS, matching the money/quantity discipline used
 * everywhere here: a round trip through a JS float would silently lose a
 * millilitre.
 */

export const MEASUREMENT_MODEL = Object.freeze({
  STOCK: 'STOCK',
  TOTALIZER: 'TOTALIZER',
});

export const FLOW_METER_STATUS = Object.freeze({
  IDLE: 'IDLE',
  DISPENSING: 'DISPENSING',
  FAULT: 'FAULT',
});

/** Why a read could not produce a trustworthy number. HTTP-agnostic. */
export const FLOW_METER_ERROR = Object.freeze({
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  METER_FAULT: 'METER_FAULT',
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
  AUTH_FAILED: 'AUTH_FAILED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
});

export class FlowMeterError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'FlowMeterError';
    this.code = code;
    this.detail = detail;
  }

  /**
   * A recoverable failure is one where the sensible response is "let the driver
   * type it in this once", not "abort the delivery": the tanker is at the
   * customer and the fuel still has to move.
   */
  get isRecoverable() {
    return (
      this.code === FLOW_METER_ERROR.DEVICE_OFFLINE || this.code === FLOW_METER_ERROR.METER_FAULT
    );
  }
}

/**
 * @typedef {Object} FlowMeterReading
 * @property {'STOCK'|'TOTALIZER'} measurement Which model this reading is.
 * @property {string|null} stockLitres    Current litres in the tank. Set for STOCK.
 * @property {string|null} totalizerGross  Cumulative dispensed, observed temp. Set for TOTALIZER.
 * @property {string|null} totalizerNet    Cumulative dispensed, compensated to 15 °C, or null.
 * @property {string|null} temperatureC
 * @property {string|null} registerMax     Rollover ceiling (TOTALIZER only, BR-904).
 * @property {'IDLE'|'DISPENSING'|'FAULT'} status
 * @property {{ latitude: number, longitude: number }|null} location Where the tanker was.
 * @property {string|null} movementStatus  e.g. "PARKED" / "MOVING" (vehicle telematics, not dispensing).
 * @property {Date}        capturedAt      When WE received it (the vendor sends no timestamp).
 * @property {string|null} deviceRef       Vehicle/device key used, for audit.
 * @property {object}      raw             The provider's raw payload, kept verbatim for audit.
 */

/**
 * @typedef {Object} FlowMeterProvider
 * @property {string} name
 * @property {'STOCK'|'TOTALIZER'} measurement The model every reading uses.
 * @property {(ref: { fleetNumber?: string, registration: string }) => Promise<FlowMeterReading>} read
 *   Resolves with the current reading, or throws a {@link FlowMeterError}.
 */

/**
 * Litres delivered between an opening and a closing reading, honouring the
 * measurement model. Returns `{ ok, litres }` or `{ ok:false, code }`.
 *
 * STOCK: the tank falls as fuel leaves, so delivered = opening − closing. A
 * NEGATIVE result means the tank grew between the two reads — a refill, or a
 * bad sensor value — and must not be billed silently.
 *
 * TOTALIZER math (with rollover) stays where it already lives, in
 * delivery.service.js `computeDeliveredQuantity`; this helper covers the STOCK
 * path the dezel4u integration uses.
 */
export const deliveredFromStock = (openingLitres, closingLitres) => {
  const opening = Number(openingLitres);
  const closing = Number(closingLitres);

  if (!Number.isFinite(opening) || !Number.isFinite(closing)) {
    return { ok: false, code: 'INVALID_READING' };
  }

  const delivered = opening - closing;
  if (delivered < 0) {
    // Tank went UP between start and stop — a refill mid-delivery or a sensor
    // glitch. A human decides; we do not invent a quantity.
    return { ok: false, code: 'STOCK_INCREASED' };
  }

  return { ok: true, litres: delivered.toFixed(3) };
};
