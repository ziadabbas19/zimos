'use strict';

// Writes sample waybill PDFs for eyeballing the layout: Arabic, mixed-script,
// English-only, manual and Bosta shipments. No database needed — the models
// are built by hand and fed to the same renderer the endpoint uses.
//
//   node scripts/waybill-samples.js [outDir]     (default: ./waybill-samples)

const fs = require('fs');
const path = require('path');
const { renderWaybillPdf, buildQrPayload, carrierInfo } = require('../src/modules/waybill/waybillService');

const outDir = path.resolve(process.argv[2] || 'waybill-samples');

function model({ name, phone, address, paymentMethod = 'cod', total = 45000, shipment = null, storeName = 'Zimos Demo Store' }) {
  const order = {
    orderNumber: 'ZG-10042',
    totalAmount: String(total),
    currency: 'EGP',
    paymentMethod,
    createdAt: new Date('2026-09-25T10:00:00Z'),
  };
  const booked = shipment && shipment.booked;
  const row = shipment && {
    trackingCode: 'zg123456789',
    carrierCode: shipment.carrierCode,
    waybillNumber: shipment.waybillNumber || null,
    carrierResponse: booked ? { carrierShipmentId: `DLV-${shipment.waybillNumber}` } : null,
    status: 'created',
  };
  const m = {
    order,
    workspace: { name: storeName, logoUrl: null },
    shipment: row,
    carrier: carrierInfo(row),
    trackingValue: booked ? row.waybillNumber : (row && row.trackingCode) || order.orderNumber,
    isCod: paymentMethod === 'cod',
    storeName,
    shipTo: { fullName: name, phone },
    address,
  };
  m.qrPayload = buildQrPayload(m);
  return m;
}

const SAMPLES = {
  'arabic-no-shipment': model({
    name: 'زياد عباس',
    phone: '01012345678',
    address: { country: 'EG', province: 'الغربية', city: 'كفر الزيات', addressLine: 'شارع التحرير، عمارة ١٥، الدور الثالث، شقة 7 بجوار مسجد النور' },
  }),
  'mixed-script-manual-with-number': model({
    name: 'زياد Abbas',
    phone: '+20 101 234 5678',
    address: { country: 'EG', province: 'الغربية (Gharbia)', city: 'Kafr Elzayat', addressLine: 'السلخانة, Kafr Elzayat', postalCode: '31611' },
    shipment: { carrierCode: 'Aramex', waybillNumber: 'ARX-99812' },
  }),
  'arabic-manual-without-number': model({
    name: 'منى عادل حسن',
    phone: '01098765432',
    address: { country: 'EG', province: 'القاهرة', city: 'مدينة نصر', addressLine: '12 شارع عباس العقاد' },
    shipment: { carrierCode: 'manual' },
  }),
  'arabic-bosta': model({
    name: 'زياد عباس',
    phone: '01012345678',
    address: { country: 'EG', province: 'الغربية (Gharbia)', city: 'Kafr Elzayat', addressLine: 'السلخانة، بجوار الصيدلية' },
    shipment: { carrierCode: 'bosta', waybillNumber: '7234519', booked: true },
  }),
  'english-prepaid': model({
    name: 'Mona Adel Hassan',
    phone: '01012345678',
    paymentMethod: 'card',
    address: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '12 Abbas El Akkad Street, Building 4, Apt 12', postalCode: '11371' },
  }),
  'long-arabic-address': model({
    name: 'عبد الرحمن محمد عبد الله السيد',
    phone: '01112223334',
    address: {
      country: 'EG',
      province: 'الإسكندرية',
      city: 'سيدي بشر',
      addressLine: 'شارع خالد بن الوليد متفرع من شارع جمال عبد الناصر، عمارة رقم 23 أمام سوبر ماركت الحمد، الدور الخامس شقة 18، الرجاء الاتصال قبل الوصول بنصف ساعة لأن الجرس لا يعمل',
    },
    shipment: { carrierCode: 'bosta', waybillNumber: '98765432', booked: true },
  }),
};

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, m] of Object.entries(SAMPLES)) {
    const file = path.join(outDir, `waybill-${name}.pdf`);
    fs.writeFileSync(file, await renderWaybillPdf(m));
    console.log(file);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
