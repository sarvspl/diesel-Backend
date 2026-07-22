/**
 * RBAC vocabulary.
 *
 * Permissions are DATA, not logic. Middleware receives a code and checks it
 * against the caller's effective set; no code path branches on a role name
 * (ADR-008, docs/03 §4.1).
 *
 * This is the minimal set the identity phase needs. Domain permissions
 * (`order.cancel`, `credit.limit.set`, ...) are added by their owning modules.
 */

/** Account kinds. Mirrors the `Principal` enum in the Prisma schema. */
export const PRINCIPALS = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  ADMIN: 'ADMIN',
});

/** Roles seeded by `prisma/seed.js`. */
export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
});

/**
 * `resource.action[.scope]`.
 *
 * The `.self` / `.any` scope suffix is the important convention: it keeps
 * "read my own sessions" and "read anyone's sessions" as separate grants, so a
 * customer role can never accidentally inherit an administrative capability by
 * being given a coarser permission.
 */
export const PERMISSIONS = Object.freeze({
  // Own account
  USER_READ_SELF: 'user.read.self',
  USER_UPDATE_SELF: 'user.update.self',
  SESSION_READ_SELF: 'session.read.self',
  SESSION_REVOKE_SELF: 'session.revoke.self',

  // Own customer profile and addresses
  CUSTOMER_READ_SELF: 'customer.read.self',
  CUSTOMER_UPDATE_SELF: 'customer.update.self',
  ADDRESS_MANAGE_SELF: 'address.manage.self',

  // Own corporate account. NOTE: holding these means "may act on my own
  // company at all". WHICH actions are permitted is decided by the caller's
  // CorporateMemberRole, checked separately - a platform permission cannot
  // express "owner of company X but only a viewer of company Y".
  CORPORATE_READ_SELF: 'corporate.read.self',
  CORPORATE_REGISTER: 'corporate.register',
  CORPORATE_MEMBER_MANAGE: 'corporate.member.manage',

  // Other accounts - administrative
  USER_READ_ANY: 'user.read.any',
  CUSTOMER_READ_ANY: 'customer.read.any',
  CORPORATE_READ_ANY: 'corporate.read.any',
  /// Approve or reject a corporate registration. High value: it decides who
  /// may trade on the platform.
  CORPORATE_VERIFY: 'corporate.verify',
  CORPORATE_SUSPEND: 'corporate.suspend',

  // Fleet - administrative
  DRIVER_READ: 'driver.read',
  DRIVER_MANAGE: 'driver.manage',
  VEHICLE_READ: 'vehicle.read',
  VEHICLE_MANAGE: 'vehicle.manage',
  VEHICLE_ASSIGN: 'vehicle.assign',
  /// Recording a refill or a meter reading is routine operations work.
  INVENTORY_RECORD: 'inventory.record',
  /// Correcting stock by hand is NOT routine. A manual adjustment can conceal
  /// theft, so it is a separate, higher grant than recording a refill.
  INVENTORY_ADJUST: 'inventory.adjust',
  // Pricing & catalog - administrative
  PRODUCT_READ: 'product.read',
  PRODUCT_MANAGE: 'product.manage',
  PRICE_READ: 'price.read',
  PRICE_MANAGE: 'price.manage',
  /// Second-administrator sign-off for a price outside the sanity band
  /// (BR-607). Separate from PRICE_MANAGE so one person cannot both set an
  /// out-of-band price and approve it.
  PRICE_APPROVE: 'price.approve',
  TAX_READ: 'tax.read',
  TAX_MANAGE: 'tax.manage',
  DELIVERY_CHARGE_READ: 'delivery_charge.read',
  DELIVERY_CHARGE_MANAGE: 'delivery_charge.manage',
  /// Customers hold this; it is what lets them price an order without any
  /// ability to see or change pricing configuration.
  QUOTE_CREATE: 'quote.create',

  // Ordering.
  //
  // docs/03 §4.3 names the catalogue: order.read, order.read.all, order.cancel,
  // order.assign, order.reassign, order.adjust, order.override_state. Two
  // notes on the gaps:
  //
  //   order.create      is NOT in that catalogue. Placing an order is listed
  //                     there as a customer CAPABILITY rather than a named
  //                     permission. It is added here for the same reason
  //                     quote.create exists: every other endpoint is gated by
  //                     a permission, and one endpoint gated only by principal
  //                     is the inconsistency someone eventually gets wrong.
  //
  //   order.override_state is deliberately NOT defined. It appears in the
  //                     catalogue with no stated semantics, guards or audit
  //                     requirement, and a break-glass grant that lets someone
  //                     bypass the transition table is precisely the second
  //                     write path docs/07 §10.1 exists to forbid. Defining it
  //                     needs a decision, not a guess.
  ORDER_CREATE: 'order.create',
  /// Own orders.
  ORDER_READ: 'order.read',
  /// Anyone's orders. The administrative read.
  ORDER_READ_ALL: 'order.read.all',
  ORDER_CANCEL: 'order.cancel',
  /// Drive a legal transition by hand. Operations work, not routine.
  ORDER_ADJUST: 'order.adjust',
  /// Hold and release fuel against an order. Separate from order.adjust: a
  /// reservation moves stock commitments, which is a different kind of harm
  /// from moving an order's status.
  ORDER_RESERVE: 'order.reserve',

  SHIFT_READ: 'shift.read',
  SHIFT_MANAGE: 'shift.manage',

  // --- Driver self-service -------------------------------------------------
  // Scoped to the caller's OWN driver profile, resolved from the token. A
  // driver never names a driverProfileId, so no request can reach another
  // driver's shift or orders (BR-225).
  /// Read own driver profile and assigned vehicle.
  DRIVER_READ_SELF: 'driver.read.self',
  /// Start and end own shift, and set own availability.
  SHIFT_MANAGE_SELF: 'shift.manage.self',
  /// Read orders assigned to the vehicle this driver is operating.
  ORDER_READ_ASSIGNED: 'order.read.assigned',
  /// Progress an assigned order through the delivery states.
  DELIVERY_EXECUTE: 'delivery.execute',
  /// Record meter readings and submit the completed delivery.
  DELIVERY_SUBMIT: 'delivery.submit',
  USER_UPDATE_ANY: 'user.update.any',
  USER_BLOCK: 'user.block',
  SESSION_READ_ANY: 'session.read.any',
  SESSION_REVOKE_ANY: 'session.revoke.any',

  // Access control - the highest-value permissions in the system (docs/03 §8)
  ROLE_READ: 'role.read',
  ROLE_MANAGE: 'role.manage',
  ROLE_ASSIGN: 'role.assign',
  PERMISSION_READ: 'permission.read',
});

/** Descriptions for the seed. Kept beside the codes so they cannot drift. */
export const PERMISSION_DEFINITIONS = Object.freeze([
  [PERMISSIONS.USER_READ_SELF, 'user', 'read.self', 'Read own identity'],
  [PERMISSIONS.USER_UPDATE_SELF, 'user', 'update.self', 'Update own identity'],
  [PERMISSIONS.SESSION_READ_SELF, 'session', 'read.self', 'List own sessions'],
  [PERMISSIONS.SESSION_REVOKE_SELF, 'session', 'revoke.self', 'Revoke own sessions'],
  [PERMISSIONS.CUSTOMER_READ_SELF, 'customer', 'read.self', 'Read own customer profile'],
  [PERMISSIONS.CUSTOMER_UPDATE_SELF, 'customer', 'update.self', 'Update own customer profile'],
  [PERMISSIONS.ADDRESS_MANAGE_SELF, 'address', 'manage.self', 'Manage own delivery addresses'],
  [PERMISSIONS.CORPORATE_READ_SELF, 'corporate', 'read.self', 'Read own corporate account'],
  [PERMISSIONS.CORPORATE_REGISTER, 'corporate', 'register', 'Submit a corporate registration'],
  [PERMISSIONS.CORPORATE_MEMBER_MANAGE, 'corporate', 'member.manage', 'Manage own company members'],
  [PERMISSIONS.CUSTOMER_READ_ANY, 'customer', 'read.any', "Read any customer's profile"],
  [PERMISSIONS.CORPORATE_READ_ANY, 'corporate', 'read.any', 'Read any corporate account'],
  [
    PERMISSIONS.CORPORATE_VERIFY,
    'corporate',
    'verify',
    'Approve or reject a corporate registration',
  ],
  [
    PERMISSIONS.CORPORATE_SUSPEND,
    'corporate',
    'suspend',
    'Suspend or reactivate a corporate account',
  ],
  [PERMISSIONS.DRIVER_READ, 'driver', 'read', 'View driver profiles'],
  [PERMISSIONS.DRIVER_MANAGE, 'driver', 'manage', 'Create and edit driver profiles'],
  [PERMISSIONS.VEHICLE_READ, 'vehicle', 'read', 'View vehicles'],
  [PERMISSIONS.VEHICLE_MANAGE, 'vehicle', 'manage', 'Create, edit and retire vehicles'],
  [PERMISSIONS.VEHICLE_ASSIGN, 'vehicle', 'assign', 'Assign and unassign drivers'],
  [PERMISSIONS.INVENTORY_RECORD, 'inventory', 'record', 'Record refills and meter readings'],
  [PERMISSIONS.INVENTORY_ADJUST, 'inventory', 'adjust', 'Correct fuel stock by hand'],
  [PERMISSIONS.PRODUCT_READ, 'product', 'read', 'View fuel products'],
  [PERMISSIONS.PRODUCT_MANAGE, 'product', 'manage', 'Create and edit fuel products'],
  [PERMISSIONS.PRICE_READ, 'price', 'read', 'View price history'],
  [PERMISSIONS.PRICE_MANAGE, 'price', 'manage', 'Publish new price versions'],
  [PERMISSIONS.PRICE_APPROVE, 'price', 'approve', 'Approve an out-of-band price change'],
  [PERMISSIONS.TAX_READ, 'tax', 'read', 'View tax rules'],
  [PERMISSIONS.TAX_MANAGE, 'tax', 'manage', 'Create and edit tax rules'],
  [PERMISSIONS.DELIVERY_CHARGE_READ, 'delivery_charge', 'read', 'View delivery charge rules'],
  [PERMISSIONS.DELIVERY_CHARGE_MANAGE, 'delivery_charge', 'manage', 'Manage delivery charge rules'],
  [PERMISSIONS.QUOTE_CREATE, 'quote', 'create', 'Generate a price quote'],
  [PERMISSIONS.ORDER_CREATE, 'order', 'create', 'Place an order from a quote'],
  [PERMISSIONS.ORDER_READ, 'order', 'read', 'Read own orders'],
  [PERMISSIONS.ORDER_READ_ALL, 'order', 'read.all', "Read any customer's orders"],
  [PERMISSIONS.ORDER_CANCEL, 'order', 'cancel', 'Cancel an order'],
  [PERMISSIONS.ORDER_ADJUST, 'order', 'adjust', 'Drive an order state transition by hand'],
  [PERMISSIONS.ORDER_RESERVE, 'order', 'reserve', 'Hold or release fuel against an order'],
  [PERMISSIONS.SHIFT_READ, 'shift', 'read', 'View driver shifts'],
  [PERMISSIONS.SHIFT_MANAGE, 'shift', 'manage', 'Start and end driver shifts'],
  [PERMISSIONS.DRIVER_READ_SELF, 'driver', 'read.self', 'Read own driver profile'],
  [PERMISSIONS.SHIFT_MANAGE_SELF, 'shift', 'manage.self', 'Start and end own shift'],
  [PERMISSIONS.ORDER_READ_ASSIGNED, 'order', 'read.assigned', 'Read orders assigned to me'],
  [PERMISSIONS.DELIVERY_EXECUTE, 'delivery', 'execute', 'Progress an assigned delivery'],
  [PERMISSIONS.DELIVERY_SUBMIT, 'delivery', 'submit', 'Record meter readings and submit a delivery'],
  [PERMISSIONS.USER_READ_ANY, 'user', 'read.any', "Read any user's identity"],
  [PERMISSIONS.USER_UPDATE_ANY, 'user', 'update.any', "Update any user's identity"],
  [PERMISSIONS.USER_BLOCK, 'user', 'block', 'Block or unblock a user'],
  [PERMISSIONS.SESSION_READ_ANY, 'session', 'read.any', "List any user's sessions"],
  [PERMISSIONS.SESSION_REVOKE_ANY, 'session', 'revoke.any', "Revoke any user's sessions"],
  [PERMISSIONS.ROLE_READ, 'role', 'read', 'View roles and their permissions'],
  [PERMISSIONS.ROLE_MANAGE, 'role', 'manage', 'Create, edit and delete roles'],
  [PERMISSIONS.ROLE_ASSIGN, 'role', 'assign', 'Assign roles to users'],
  [PERMISSIONS.PERMISSION_READ, 'permission', 'read', 'View the permission catalogue'],
]);

/** Every capability an account holds over its own identity. */
const SELF_SERVICE = [
  PERMISSIONS.USER_READ_SELF,
  PERMISSIONS.USER_UPDATE_SELF,
  PERMISSIONS.SESSION_READ_SELF,
  PERMISSIONS.SESSION_REVOKE_SELF,
];

/**
 * Buying capability, granted to customers and drivers alike.
 *
 * Drivers get it because a driver ordering fuel for their own generator is a
 * legitimate customer - though they do so through their separate CUSTOMER
 * account (ADR-016), not their driver one.
 */
const CUSTOMER_SELF_SERVICE = [
  PERMISSIONS.CUSTOMER_READ_SELF,
  PERMISSIONS.CUSTOMER_UPDATE_SELF,
  PERMISSIONS.ADDRESS_MANAGE_SELF,
  PERMISSIONS.CORPORATE_READ_SELF,
  PERMISSIONS.CORPORATE_REGISTER,
  PERMISSIONS.CORPORATE_MEMBER_MANAGE,
  PERMISSIONS.QUOTE_CREATE,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_READ,
  PERMISSIONS.ORDER_CANCEL,
];

/**
 * Role composition.
 *
 * Note the separation of duties: ADMIN can operate the platform but cannot
 * grant itself more power - `role.manage` and `role.assign` are SUPER_ADMIN
 * only. An administrator who can edit roles has, in effect, every permission.
 */
export const ROLE_DEFINITIONS = Object.freeze([
  {
    code: ROLES.SUPER_ADMIN,
    name: 'Super Administrator',
    description: 'Full control including role and permission management. Break-glass access.',
    permissions: Object.values(PERMISSIONS),
  },
  {
    code: ROLES.ADMIN,
    name: 'Administrator',
    description: 'Platform administration. Cannot manage roles or permissions.',
    permissions: [
      ...SELF_SERVICE,
      PERMISSIONS.USER_READ_ANY,
      PERMISSIONS.USER_UPDATE_ANY,
      PERMISSIONS.USER_BLOCK,
      PERMISSIONS.SESSION_READ_ANY,
      PERMISSIONS.SESSION_REVOKE_ANY,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.PERMISSION_READ,
      PERMISSIONS.CUSTOMER_READ_ANY,
      PERMISSIONS.CORPORATE_READ_ANY,
      PERMISSIONS.CORPORATE_VERIFY,
      PERMISSIONS.CORPORATE_SUSPEND,
      PERMISSIONS.DRIVER_READ,
      PERMISSIONS.DRIVER_MANAGE,
      PERMISSIONS.VEHICLE_READ,
      PERMISSIONS.VEHICLE_MANAGE,
      PERMISSIONS.VEHICLE_ASSIGN,
      PERMISSIONS.INVENTORY_RECORD,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.SHIFT_READ,
      PERMISSIONS.SHIFT_MANAGE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.PRODUCT_MANAGE,
      PERMISSIONS.PRICE_READ,
      PERMISSIONS.PRICE_MANAGE,
      PERMISSIONS.TAX_READ,
      PERMISSIONS.TAX_MANAGE,
      PERMISSIONS.DELIVERY_CHARGE_READ,
      PERMISSIONS.DELIVERY_CHARGE_MANAGE,
      // Orders. docs/03 §4.4 gives read to every operational role and reserves
      // cancel/adjust for SUPER_ADMIN, ADMIN and OPERATIONS_MANAGER - of which
      // only the first two ship in Phase 1.
      PERMISSIONS.ORDER_READ_ALL,
      PERMISSIONS.ORDER_CANCEL,
      PERMISSIONS.ORDER_ADJUST,
      PERMISSIONS.ORDER_RESERVE,
    ],
  },
  {
    code: ROLES.CUSTOMER,
    name: 'Customer',
    description: 'Self-service access for a customer identity.',
    permissions: [...SELF_SERVICE, ...CUSTOMER_SELF_SERVICE],
  },
  {
    code: ROLES.DRIVER,
    name: 'Driver',
    description: 'Self-service access for a driver identity.',
    permissions: [
      ...SELF_SERVICE,
      /**
       * Everything a driver holds is `.self` or `.assigned` scoped. There is
       * deliberately no `driver.read` or `order.read.all` here: a driver sees
       * their own profile, their own shift, and only the orders on the vehicle
       * they are operating (docs/03 §3).
       */
      PERMISSIONS.DRIVER_READ_SELF,
      PERMISSIONS.SHIFT_MANAGE_SELF,
      PERMISSIONS.ORDER_READ_ASSIGNED,
      PERMISSIONS.DELIVERY_EXECUTE,
      PERMISSIONS.DELIVERY_SUBMIT,
    ],
  },
]);

/** The role granted automatically when a principal self-registers. */
export const DEFAULT_ROLE_BY_PRINCIPAL = Object.freeze({
  [PRINCIPALS.CUSTOMER]: ROLES.CUSTOMER,
  [PRINCIPALS.DRIVER]: ROLES.DRIVER,
  [PRINCIPALS.ADMIN]: ROLES.ADMIN,
});
