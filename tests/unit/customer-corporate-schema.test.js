import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMemberSchema,
  registerCorporateSchema,
  rejectCorporateSchema,
  updateMemberSchema,
} from '../../src/modules/corporate/corporate.schema.js';
import {
  createAddressSchema,
  registerCustomerSchema,
  updateAddressSchema,
  updateCustomerSchema,
} from '../../src/modules/customer/customer.schema.js';

describe('customer profile schema', () => {
  it('defaults marketing consent to false', () => {
    const result = registerCustomerSchema.body.safeParse({ fullName: 'Asha Rao' });

    // Opt-in must be an explicit act; a pre-ticked box is not consent (BR-107).
    assert.equal(result.success, true);
    assert.equal(result.data.marketingOptIn, false);
  });

  it('rejects an attempt to set phone or email through the profile', () => {
    // Identity fields live on `users` and changing a phone needs OTP
    // verification of both numbers. Zod strips unknown keys, so the values
    // must not survive parsing into something the service could write.
    const result = registerCustomerSchema.body.safeParse({
      fullName: 'Asha Rao',
      phone: '+919876543210',
      email: 'asha@example.com',
    });

    assert.equal(result.success, true);
    assert.equal(result.data.phone, undefined);
    assert.equal(result.data.email, undefined);
  });

  it('rejects an empty PATCH', () => {
    assert.equal(updateCustomerSchema.body.safeParse({}).success, false);
  });

  it('validates an emergency contact number', () => {
    assert.equal(
      updateCustomerSchema.body.safeParse({ emergencyContactPhone: '12345' }).success,
      false
    );
  });
});

describe('address schema', () => {
  const valid = {
    line1: 'Plot 14, Industrial Estate',
    city: 'Kolkata',
    state: 'West Bengal',
    pincode: '700156',
    latitude: '22.5726',
    longitude: '88.3639',
  };

  it('accepts a valid address', () => {
    assert.equal(createAddressSchema.body.safeParse(valid).success, true);
  });

  it('keeps coordinates as strings', () => {
    const result = createAddressSchema.body.safeParse(valid);

    // A JSON number is a double in every client. Rounding a coordinate moves
    // the delivery point by metres - the exact error geofence checks detect.
    assert.equal(typeof result.data.latitude, 'string');
    assert.equal(result.data.latitude, '22.5726');
  });

  it('rejects out-of-range coordinates', () => {
    assert.equal(createAddressSchema.body.safeParse({ ...valid, latitude: '91.0' }).success, false);
    assert.equal(
      createAddressSchema.body.safeParse({ ...valid, longitude: '181.0' }).success,
      false
    );
  });

  it('rejects a numeric latitude', () => {
    assert.equal(
      createAddressSchema.body.safeParse({ ...valid, latitude: 22.5726 }).success,
      false
    );
  });

  it('rejects an invalid PIN code', () => {
    for (const pincode of ['12345', '0123456', 'ABCDEF', '012345']) {
      assert.equal(
        createAddressSchema.body.safeParse({ ...valid, pincode }).success,
        false,
        `${pincode} should be rejected`
      );
    }
  });

  it('requires latitude and longitude together on update', () => {
    // One without the other would silently place the address somewhere the
    // caller never intended.
    assert.equal(updateAddressSchema.body.safeParse({ latitude: '22.5726' }).success, false);
    assert.equal(
      updateAddressSchema.body.safeParse({ latitude: '22.5726', longitude: '88.3639' }).success,
      true
    );
  });

  it('rejects an empty update', () => {
    assert.equal(updateAddressSchema.body.safeParse({}).success, false);
  });
});

describe('corporate registration schema', () => {
  const valid = {
    legalName: 'Acme Fuels Private Limited',
    registrationIdType: 'CIN',
    registrationNumber: 'U40100WB2020PTC123456',
  };

  it('accepts a valid registration', () => {
    assert.equal(registerCorporateSchema.body.safeParse(valid).success, true);
  });

  it('normalises the registration number to upper case', () => {
    const result = registerCorporateSchema.body.safeParse({
      ...valid,
      registrationNumber: 'u40100wb2020ptc123456',
    });

    assert.equal(result.data.registrationNumber, 'U40100WB2020PTC123456');
  });

  it('validates GSTIN format when supplied', () => {
    assert.equal(
      registerCorporateSchema.body.safeParse({ ...valid, gstin: '19ABQCS3641F1Z0' }).success,
      true
    );
    assert.equal(
      registerCorporateSchema.body.safeParse({ ...valid, gstin: 'NOT-A-GSTIN' }).success,
      false
    );
  });

  it('validates PAN format when supplied', () => {
    assert.equal(
      registerCorporateSchema.body.safeParse({ ...valid, pan: 'ABQCS3641F' }).success,
      true
    );
    assert.equal(registerCorporateSchema.body.safeParse({ ...valid, pan: '123' }).success, false);
  });

  it('rejects an unknown registration id type', () => {
    assert.equal(
      registerCorporateSchema.body.safeParse({ ...valid, registrationIdType: 'MAGIC' }).success,
      false
    );
  });

  it('ignores a client-supplied verification status', () => {
    // Status is set by the workflow, never by the applicant.
    const result = registerCorporateSchema.body.safeParse({
      ...valid,
      verificationStatus: 'APPROVED',
      accountStatus: 'ACTIVE',
      creditFacilityStatus: 'ACTIVE',
    });

    assert.equal(result.success, true);
    assert.equal(result.data.verificationStatus, undefined);
    assert.equal(result.data.accountStatus, undefined);
    assert.equal(result.data.creditFacilityStatus, undefined);
  });
});

describe('corporate member schema', () => {
  it('accepts assignable roles', () => {
    for (const role of ['CORPORATE_ADMIN', 'PURCHASE_MANAGER', 'VIEWER']) {
      assert.equal(
        addMemberSchema.body.safeParse({ phone: '+919876543210', role }).success,
        true,
        role
      );
    }
  });

  it('refuses to assign CORPORATE_OWNER', () => {
    // Ownership transfer is its own operation with the single-owner rule
    // attached (BR-222); it must not happen as a side effect of adding a member.
    assert.equal(
      addMemberSchema.body.safeParse({ phone: '+919876543210', role: 'CORPORATE_OWNER' }).success,
      false
    );
    assert.equal(updateMemberSchema.body.safeParse({ role: 'CORPORATE_OWNER' }).success, false);
  });

  it('requires a valid Indian phone number', () => {
    assert.equal(
      addMemberSchema.body.safeParse({ phone: '+14155552671', role: 'VIEWER' }).success,
      false
    );
  });
});

describe('corporate rejection schema', () => {
  it('requires both a reason code and an applicant note', () => {
    // A rejection the applicant cannot understand is unappealable (BR-205).
    assert.equal(rejectCorporateSchema.body.safeParse({}).success, false);
    assert.equal(
      rejectCorporateSchema.body.safeParse({ reasonCode: 'INVALID_CIN' }).success,
      false
    );
    assert.equal(
      rejectCorporateSchema.body.safeParse({
        reasonCode: 'INVALID_CIN',
        applicantNote: 'The CIN could not be verified against the registry.',
      }).success,
      true
    );
  });

  it('normalises the reason code', () => {
    const result = rejectCorporateSchema.body.safeParse({
      reasonCode: 'invalid_cin',
      applicantNote: 'Could not verify.',
    });

    assert.equal(result.data.reasonCode, 'INVALID_CIN');
  });
});
