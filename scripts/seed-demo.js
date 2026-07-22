import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '#prisma';

/**
 * Demo data for local development and the client walkthrough.
 *
 * NOT a migration seed. `prisma/seed.js` deliberately creates no users; this
 * exists so an operator can see populated screens without hand-registering a
 * dozen accounts through the app.
 *
 * Idempotent: re-running updates rather than duplicating.
 *
 *   npm run seed:demo
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CUSTOMERS = [
  ['+919876543210', 'anil.sharma@kalyanieng.in', 'Anil Sharma', 'ACTIVE'],
  ['+919876543211', 'priya.nair@example.in', 'Priya Nair', 'ACTIVE'],
  ['+919876543212', 'rakesh.kumar@example.in', 'Rakesh Kumar', 'ACTIVE'],
  ['+919876543213', null, 'Sunita Desai', 'ACTIVE'],
  ['+919876543214', 'vikram.rao@bharatlogistics.in', 'Vikram Rao', 'ACTIVE'],
  ['+919876543215', 'meera.iyer@example.in', 'Meera Iyer', 'BLOCKED'],
  ['+919876543216', 'arjun.patel@example.in', 'Arjun Patel', 'ACTIVE'],
];

const COMPANIES = [
  ['Kalyani Engineering Private Limited', 'Kalyani Engineering', 'CIN', 'U29100PN2011PTC138901', '27AABCK1234M1Z5', 'PENDING', 'INACTIVE'],
  ['Bharat Logistics LLP', 'Bharat Logistics', 'GSTIN', '27AABCB5678N1Z3', '27AABCB5678N1Z3', 'PENDING', 'INACTIVE'],
  ['Sunrise Infra Projects Limited', 'Sunrise Infra', 'CIN', 'U45200PN2015PLC155432', '27AACCS9012P1Z7', 'APPROVED', 'ACTIVE'],
  ['Deccan Cold Storage Private Limited', 'Deccan Cold Storage', 'CIN', 'U15122PN2018PTC177889', '27AADCD3456Q1Z2', 'APPROVED', 'ACTIVE'],
  ['Western Ghats Quarry Works', 'WG Quarry', 'UDYAM', 'UDYAM-MH-26-0012345', null, 'APPROVED', 'SUSPENDED'],
  ['Nova Fabrication Works', 'Nova Fabrication', 'PAN', 'AACCN7788R', null, 'REJECTED', 'INACTIVE'],
];

async function main() {
  const customerRole = await prisma.role.findUnique({ where: { code: 'CUSTOMER' } });
  if (!customerRole) throw new Error('Run `npm run prisma:seed` first — the CUSTOMER role is missing.');

  const users = [];

  for (const [phone, email, fullName, status] of CUSTOMERS) {
    const user = await prisma.user.upsert({
      where: { phone_principal: { phone, principal: 'CUSTOMER' } },
      create: {
        principal: 'CUSTOMER',
        phone,
        email,
        status,
        phoneVerifiedAt: new Date(),
        roles: { create: { roleId: customerRole.id } },
      },
      update: { email, status },
      select: { id: true },
    });

    await prisma.customerProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, fullName, marketingOptIn: Math.random() > 0.5 },
      update: { fullName },
    });

    // One address each, so the detail drawer has something real to show.
    const existing = await prisma.address.findFirst({ where: { userId: user.id } });
    if (!existing) {
      await prisma.address.create({
        data: {
          userId: user.id,
          nickname: 'Primary site',
          line1: 'Plot 14, MIDC Bhosari',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411026',
          latitude: 18.6298,
          longitude: 73.8131,
          deliveryInstructions: 'Gate 2, security pass needed',
          contactName: fullName,
          contactPhone: phone,
          isDefault: true,
          isServiceable: true,
          serviceCheckedAt: new Date(),
        },
      });
    }

    users.push(user.id);
  }

  for (const [i, [legalName, displayName, idType, regNo, gstin, verification, accountStatus]] of COMPANIES.entries()) {
    const ownerUserId = users[i % users.length];

    const account = await prisma.corporateAccount.upsert({
      where: { registrationIdType_registrationNumber: { registrationIdType: idType, registrationNumber: regNo } },
      create: {
        legalName,
        displayName,
        registrationIdType: idType,
        registrationNumber: regNo,
        gstin,
        billingLine1: 'Survey 22, Chakan Industrial Area',
        billingCity: 'Pune',
        billingState: 'Maharashtra',
        billingPincode: '410501',
        contactEmail: `accounts@${displayName.toLowerCase().replace(/\s+/g, '')}.in`,
        contactPhone: '+9198765432' + String(20 + i).slice(-2),
        createdByUserId: ownerUserId,
        verificationStatus: verification,
        accountStatus,
        creditFacilityStatus: verification === 'APPROVED' ? 'ACTIVE' : 'NOT_ENABLED',
        members: { create: { userId: ownerUserId, role: 'CORPORATE_OWNER', status: 'ACTIVE' } },
        verificationRecords: {
          create: {
            fromStatus: null,
            toStatus: 'PENDING',
            applicantNote: 'Registration submitted',
          },
        },
      },
      update: { verificationStatus: verification, accountStatus },
      select: { id: true },
    });

    // Decided companies get the decision record their status implies.
    if (verification !== 'PENDING') {
      const decided = await prisma.corporateVerificationRecord.findFirst({
        where: { corporateAccountId: account.id, toStatus: verification },
      });

      if (!decided) {
        await prisma.corporateVerificationRecord.create({
          data: {
            corporateAccountId: account.id,
            fromStatus: 'PENDING',
            toStatus: verification,
            reasonCode: verification === 'REJECTED' ? 'DOCUMENTS_INCOMPLETE' : null,
            applicantNote:
              verification === 'REJECTED'
                ? 'The registration certificate supplied was illegible. Re-apply with a clear scan.'
                : 'Verified against the MCA register.',
            adminNote: verification === 'REJECTED' ? 'Scan unreadable; asked for a re-submission.' : 'GSTIN and CIN both matched.',
          },
        });
      }
    }
  }

  const [customers, corporates] = await Promise.all([
    prisma.customerProfile.count(),
    prisma.corporateAccount.count(),
  ]);

  console.log(`\nDemo data ready.\n  customers:  ${customers}\n  corporates: ${corporates}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
