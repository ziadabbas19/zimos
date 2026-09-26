'use strict';

// A fake Mylerz behind carrierHttp.request, answering in the shapes Mylerz's
// own help pages document (https://integration.mylerz.net/Help) and the
// /token exchange the official WordPress plugin performs. Nothing here
// reaches integration.mylerz.net.
//
//   jest.spyOn(carrierHttp, 'request').mockImplementation(fakeMylerz.handle)
//
// Status values: Mylerz documents none. The fake uses the two `Status`
// strings the official plugin acts on, plus made-up ones for "unknown" cases.

const USERNAME = 'mylerz-merchant@example.com';
const PASSWORD = 'mylerz-correct-password';
const OTHER_PASSWORD = 'mylerz-other-password';

const CITIES = [
  {
    Code: 'CAI',
    ArName: 'القاهرة',
    EnName: 'Cairo',
    Zones: [
      { Code: 'NASR', ArName: 'مدينة نصر', EnName: 'Nasr City' },
      { Code: 'MAADI', ArName: 'المعادي', EnName: 'Maadi' },
      { Code: 'HELIO', ArName: 'مصر الجديدة', EnName: 'Heliopolis' },
    ],
  },
  {
    Code: 'GIZ',
    ArName: 'الجيزة',
    EnName: 'Giza',
    Zones: [
      { Code: 'DOKKI', ArName: 'الدقي', EnName: 'Dokki' },
      { Code: 'MOHANDESSIN', ArName: 'المهندسين', EnName: 'Mohandessin' },
    ],
  },
];

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake mylerz awb\n');

const DELIVERED = 'Delivered, Thank you :-)';
const REJECTED = 'Rejected - reason to be mentioned';

let fake;

function reset() {
  fake = {
    calls: [],
    tokens: new Map(), // token -> username
    packages: new Map(), // barcode -> package
    nextBarcode: 10000000000001,
    nextToken: 1,
    refuseCancel: null, // null | error message
    awbNotPdf: false,
    // AddOrders answers with a package-level ErrorMessage and no barcode.
    refuseCreate: null,
    // Passwords changed at Mylerz: logins with them fail.
    revoked: new Set(),
    // Every API call is refused even with a fresh token (no API access).
    denyAll: false,
  };
}
reset();

const envelope = (value, extra = {}) => ({
  Value: value,
  CoreValue: null,
  IsErrorState: false,
  ErrorDescription: null,
  ErrorMetadata: null,
  ...extra,
});

const reply = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json,
  text: JSON.stringify(json),
  headers: new Map(),
});

const denied = () => reply(401, { Message: 'Authorization has been denied for this request.' });

function owner(headers) {
  const match = /^bearer (.+)$/i.exec(headers.Authorization || '');
  return match ? fake.tokens.get(match[1]) || null : null;
}

async function handle({ method = 'GET', url, headers = {}, body, form }) {
  const { pathname } = new URL(url);
  fake.calls.push({ method, path: pathname, body, form, headers });

  if (method === 'POST' && pathname === '/token') {
    const ok =
      form &&
      form.grant_type === 'password' &&
      form.username === USERNAME &&
      [PASSWORD, OTHER_PASSWORD].includes(form.password) &&
      !fake.revoked.has(form.password);
    if (!ok) return reply(400, { error: 'invalid_grant', error_description: 'The user name or password is incorrect.' });
    const token = `mylerz-token-${fake.nextToken++}`;
    fake.tokens.set(token, form.username);
    return reply(200, { access_token: token, token_type: 'bearer', expires_in: 1209599 });
  }

  const user = owner(headers);
  if (!user || fake.denyAll) return denied();

  if (method === 'GET' && pathname === '/api/Orders/GetWarehouses') {
    return reply(200, envelope([{ Name: 'Main Warehouse' }, { Name: 'Nasr City Store' }]));
  }
  if (method === 'GET' && pathname === '/api/packages/GetCityZoneList') {
    return reply(200, envelope(CITIES));
  }
  if (method === 'POST' && pathname === '/api/Orders/AddOrders') {
    const order = body[0];
    if (fake.refuseCreate) {
      return reply(200, envelope({ PickupOrderCode: null, Packages: [{ ErrorCode: 'E1', ErrorMessage: fake.refuseCreate }] }));
    }
    const barcode = String(fake.nextBarcode++);
    fake.packages.set(barcode, { barcode, owner: user, reference: order.Reference, status: 'New', statusId: 1, phaseId: 1, phaseName: 'Pickup' });
    return reply(
      200,
      envelope({
        PickupOrderCode: `PU-${barcode.slice(-4)}`,
        PickupDateTime: '2026-09-26T12:00:00',
        Packages: [
          {
            packageNo: 1,
            Reference: order.Reference,
            BarCode: barcode,
            Status: 'New',
            DestinationHubCode: 'HUB-CAI',
            Pieces: [{ Barcode: `${barcode}01` }],
            PostalUPNumber: null,
            ErrorCode: null,
            ErrorMessage: null,
          },
        ],
        ErrorCode: null,
        ErrorMessage: null,
      })
    );
  }
  if (method === 'POST' && pathname === '/api/packages/GetPackageListStatus') {
    const rows = body.map((barcode) => {
      const pkg = fake.packages.get(String(barcode));
      if (!pkg || pkg.owner !== user) return { BarCode: barcode, ErrorMessage: 'Package not found' };
      return {
        BarCode: pkg.barcode,
        Status: pkg.status,
        PhaseName: pkg.phaseName,
        StatusName: pkg.status,
        StatusId: pkg.statusId,
        PhaseId: pkg.phaseId,
        StatusDate: '2026-09-26T13:00:00',
        ErrorMessage: null,
      };
    });
    return reply(200, envelope(rows));
  }
  if (method === 'POST' && pathname === '/api/packages/CancelPackage') {
    const rows = body.map(({ Barcode }) => {
      const pkg = fake.packages.get(String(Barcode));
      if (!pkg || pkg.owner !== user) return { Barcode, IsChanged: false, ErrorCode: 'NF', ErrorMessage: 'Package not found' };
      if (fake.refuseCancel) return { Barcode, IsChanged: false, ErrorCode: 'NA', ErrorMessage: fake.refuseCancel };
      Object.assign(pkg, { status: 'Cancelled', statusId: 99 });
      return { Barcode, ReferenceNumber: pkg.reference, IsChanged: true, ErrorCode: null, ErrorMessage: null };
    });
    return reply(200, envelope(rows));
  }
  if (method === 'POST' && pathname === '/api/packages/GetAWB') {
    const pkg = fake.packages.get(String(body.Barcode));
    if (!pkg) return reply(200, envelope(null, { IsErrorState: true, ErrorDescription: 'Package not found' }));
    const bytes = fake.awbNotPdf ? Buffer.from('<html>nope</html>') : PDF_BYTES;
    return reply(200, envelope(bytes.toString('base64')));
  }
  return reply(404, { Message: `fake mylerz: no route ${method} ${pathname}` });
}

/** Moves a package inside the fake, as Mylerz's own operations would. */
function setStatus(barcode, status, statusId = 50) {
  Object.assign(fake.packages.get(String(barcode)), { status, statusId });
}

/** Every token issued so far stops working (expiry / revocation). */
function expireTokens() {
  fake.tokens.clear();
}

/** The merchant changed this password at Mylerz: tokens die, logins fail. */
function revokePassword(password) {
  fake.revoked.add(password);
  expireTokens();
}

const callsTo = (method, path) => fake.calls.filter((c) => c.method === method && c.path === path);

module.exports = {
  handle,
  reset,
  setStatus,
  expireTokens,
  revokePassword,
  callsTo,
  state: () => fake,
  USERNAME,
  PASSWORD,
  OTHER_PASSWORD,
  CITIES,
  PDF_BYTES,
  DELIVERED,
  REJECTED,
};
