/**
 * Development IoT dispense provider. Calls nobody; always authorizes, replying
 * in the vendor's shape (no MPIN — we generate it), so the driver-app flow can
 * be tested end to end without unlocking a real pump.
 *
 * @type {import('./index.js').IotDispenseProvider}
 */
export const mockIotDispenseProvider = {
  name: 'mock',

  authorize: async ({ deviceId, vehicleRegistration, requestRef }) => {
    const body = {
      iotTransactionId: `${deviceId}${requestRef}`,
      status: 'AUTHORIZED',
      lastAcceptedQty: '0000.00',
      lastAcceptedTime: '000000000000',
      deviceID: deviceId,
      vehicleRegNo: vehicleRegistration,
    };

    return {
      status: body.status,
      iotTransactionId: body.iotTransactionId,
      raw: { ...body, mock: true },
    };
  },
};
