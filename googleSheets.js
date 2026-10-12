const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const LOCAL_DATA_PATH = path.join(__dirname, 'data_stok.json');

function getLocalData() {
  if (!fs.existsSync(LOCAL_DATA_PATH)) {
    const initialData = {
      stokTerakhir: 3046,
      riwayat: []
    };
    fs.writeFileSync(LOCAL_DATA_PATH, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_DATA_PATH, 'utf-8'));
  } catch (e) {
    return { stokTerakhir: 3046, riwayat: [] };
  }
}

function saveLocalData(data) {
  fs.writeFileSync(LOCAL_DATA_PATH, JSON.stringify(data, null, 2));
}

function getSheetsClient() {
  try {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      return google.sheets({ version: 'v4', auth });
    }

    if (fs.existsSync(CREDENTIALS_PATH)) {
      const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      return google.sheets({ version: 'v4', auth });
    }

    return null;
  } catch (err) {
    console.error('Gagal inisialisasi Google Sheets Client:', err.message);
    return null;
  }
}

/**
 * Mengambil stok terakhir berdasarkan nama
 */
async function getLatestStock(salesName = null) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  const sheets = getSheetsClient();

  if (sheets && spreadsheetId) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:I`,
      });

      const rows = response.data.values;
      if (rows && rows.length > 0) {
        if (salesName) {
          const sNameLower = salesName.toLowerCase().trim();
          for (let i = rows.length - 1; i >= 0; i--) {
            const rowSales = String(rows[i][1] || '').toLowerCase().trim();
            if (rowSales === sNameLower) {
              const stokAkhir = parseInt(String(rows[i][6] || '0').replace(/[^\d]/g, ''), 10);
              if (!isNaN(stokAkhir)) return stokAkhir;
            }
          }
        }

        const lastRow = rows[rows.length - 1];
        const stokAkhir = parseInt(String(lastRow[6] || '0').replace(/[^\d]/g, ''), 10);
        if (!isNaN(stokAkhir)) {
          return stokAkhir;
        }
      }
    } catch (err) {
      console.warn('Peringatan: Gagal membaca Google Sheets, menggunakan data lokal:', err.message);
    }
  }

  const local = getLocalData();
  return local.stokTerakhir;
}

/**
 * Mengambil kategori berdasarkan nama (default 'Lapak' jika tidak tercatat)
 */
async function getCategoryByName(name) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  const sheets = getSheetsClient();

  if (sheets && spreadsheetId && name) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:I`,
      });
      const rows = response.data.values || [];
      const sNameLower = name.toLowerCase().trim();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][1] || '').toLowerCase().trim() === sNameLower) {
          return String(rows[i][8] || 'Lapak').trim();
        }
      }
    } catch (err) {
      console.error('Gagal mengambil kategori:', err.message);
    }
  }
  return 'Lapak';
}

/**
 * Mengambil daftar sales dan lapak terpisah, terurut abjad, beserta total keseluruhan stok
 */
async function getGroupedStock() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  const sheets = getSheetsClient();

  const salesMap = new Map();

  if (sheets && spreadsheetId) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:I`,
      });

      const rows = response.data.values || [];
      for (const row of rows) {
        const name = String(row[1] || '').trim();
        if (!name || name === '-') continue;
        const stok = parseInt(String(row[6] || '0').replace(/[^\d]/g, ''), 10) || 0;
        const kategori = String(row[8] || 'Lapak').trim();
        salesMap.set(name, { name, stok, kategori });
      }
    } catch (err) {
      console.error('Gagal mengambil data stok:', err.message);
    }
  }

  const allItems = Array.from(salesMap.values());
  const listSales = allItems
    .filter(item => item.kategori.toLowerCase() === 'sales')
    .sort((a, b) => a.name.localeCompare(b.name, 'id'));

  const listLapak = allItems
    .filter(item => item.kategori.toLowerCase() !== 'sales')
    .sort((a, b) => a.name.localeCompare(b.name, 'id'));

  const totalStokSales = listSales.reduce((acc, curr) => acc + curr.stok, 0);
  const totalStokLapak = listLapak.reduce((acc, curr) => acc + curr.stok, 0);
  const grandTotal = totalStokSales + totalStokLapak;

  return {
    sales: listSales,
    lapak: listLapak,
    totalStokSales,
    totalStokLapak,
    grandTotal,
  };
}

/**
 * Daftar flat untuk dropdown web dashboard / selection
 */
async function getSalesWithStock() {
  const grouped = await getGroupedStock();
  return [...grouped.sales, ...grouped.lapak];
}

/**
 * Rekapitulasi penjualan bulanan/periode tanggal
 */
async function getSalesSummaryByPeriod(startDate, endDate) {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  const sheets = getSheetsClient();

  if (!sheets || !spreadsheetId) return null;

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:I`,
    });

    const rows = response.data.values || [];
    let totalOrder = 0;
    let totalRetur = 0;
    let totalBayar = 0;
    let totalPcsTerjual = 0;

    const summaryPerNama = new Map();

    for (const row of rows) {
      const dateStr = String(row[0] || '').trim(); // Format DD/MM/YYYY
      if (!dateStr) continue;

      const parts = dateStr.split('/');
      if (parts.length !== 3) continue;
      const rowDate = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);

      if (rowDate >= startDate && rowDate <= endDate) {
        const nama = String(row[1] || '-').trim();
        const order = parseInt(String(row[3] || '0').replace(/[^\d]/g, ''), 10) || 0;
        const retur = parseInt(String(row[4] || '0').replace(/[^\d]/g, ''), 10) || 0;
        const bayar = parseInt(String(row[5] || '0').replace(/[^\d]/g, ''), 10) || 0;
        const kategori = String(row[8] || 'Lapak').trim();
        const hargaPerPcs = kategori.toLowerCase() === 'sales' ? 2500 : 3000;
        const pcsTerjual = bayar > 0 ? Math.round(bayar / hargaPerPcs) : 0;

        totalOrder += order;
        totalRetur += retur;
        totalBayar += bayar;
        totalPcsTerjual += pcsTerjual;

        if (!summaryPerNama.has(nama)) {
          summaryPerNama.set(nama, { nama, kategori, order: 0, retur: 0, bayar: 0, pcsTerjual: 0 });
        }
        const item = summaryPerNama.get(nama);
        item.order += order;
        item.retur += retur;
        item.bayar += bayar;
        item.pcsTerjual += pcsTerjual;
      }
    }

    return {
      totalOrder,
      totalRetur,
      totalBayar,
      totalPcsTerjual,
      details: Array.from(summaryPerNama.values()).sort((a, b) => b.pcsTerjual - a.pcsTerjual),
    };
  } catch (err) {
    console.error('Gagal mengambil ringkasan periode:', err.message);
    return null;
  }
}

/**
 * Menyimpan baris transaksi baru dengan kategori di kolom I
 */
async function appendTransaction(data) {
  const row = [
    data.tanggal,
    data.sales || '-',
    data.stokAwal,
    data.order || 0,
    data.retur || 0,
    data.bayar || 0,
    data.stokAkhir,
    data.catatan || '-',
    data.kategori || 'Sales'
  ];

  const local = getLocalData();
  local.stokTerakhir = data.stokAkhir;
  local.riwayat.push({
    ...data,
    createdAt: new Date().toISOString()
  });
  saveLocalData(local);

  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  const sheets = getSheetsClient();

  if (sheets && spreadsheetId) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:I`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [row],
        },
      });
      console.log('✅ Berhasil mencatat transaksi ke Google Sheets!');
    } catch (err) {
      console.error('❌ Gagal menambahkan baris ke Google Sheets:', err.message);
    }
  }

  return row;
}

async function setManualStock(newStock) {
  const local = getLocalData();
  local.stokTerakhir = newStock;
  saveLocalData(local);
  return newStock;
}

function formatRibuan(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  return Number(num).toLocaleString('id-ID');
}

module.exports = {
  getLatestStock,
  getCategoryByName,
  getGroupedStock,
  getSalesWithStock,
  getSalesSummaryByPeriod,
  appendTransaction,
  setManualStock,
  formatRibuan,
};
