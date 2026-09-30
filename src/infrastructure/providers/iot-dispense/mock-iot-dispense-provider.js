/**
 * Development IoT dispense provider. Calls nobody; always authorizes with the
 * same MPIN the vendor currently hard-codes, so the driver-app flow can be
 * tested end to end without unlocking a real pump.
 *
 * @type {import('./index.js').IotDispenseProvider}
 */
export const mockIotDispenseProvider = {
  name: 'mock',

  authorize: async ({ deviceId, requestRef }) => {
    const body = {
      iotTransactionId: `${deviceId}${requestRef}`,
      mpin: '123456',
      status: 'AUTHORIZED',
    };

    return { ...body, raw: { ...body, mock: true } };
  },
};
