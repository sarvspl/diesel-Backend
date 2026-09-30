/** The IoT dispense vendor could not be reached or gave an unusable answer. */
export class IotDispenseError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'IotDispenseError';
    this.detail = detail;
  }
}
