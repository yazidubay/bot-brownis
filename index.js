const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const os = require('os');
const {
  getLatestStock,
  getCategoryByName,
  getGroupedStock,
  getSalesWithStock,
  getSalesSummaryByPeriod,
  appendTransaction,
  setManualStock,
  formatRibuan,
} = require('./googleSheets');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

function getHargaPerPcs(kategori) {
  return String(kategori || '').toLowerCase() === 'sales' ? 2500 : 3000;
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();

function getFormattedDate() {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function getFormattedDateIndo() {
  return new Date().toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function generateReportText(data) {
  const tanggalIndo = getFormattedDateIndo();
  const orderStr = data.order > 0 ? `<b>${formatRibuan(data.order)}</b> pcs` : `<b>-</b> pcs`;
  const returStr = data.retur > 0 ? `<b>${formatRibuan(data.retur)}</b> pcs` : `<b>-</b> pcs`;
  const bayarStr = data.bayar > 0 ? `<b>${formatRibuan(data.bayar)}</b>` : `<b>-</b>`;

  return (
`📋 <b>Laporan Stok Brownis d'mila</b>

📅 Tanggal: ${tanggalIndo}
👤 Nama: <b>${data.sales || '-'}</b>

📦 Stok Awal : <b>${formatRibuan(data.stokAwal)}</b> pcs
🛒 Order : ${orderStr}
↩️ Retur : ${returStr}
💵 Bayar : ${bayarStr}

📦 Total Stok : <b>${formatRibuan(data.stokAkhir)}</b> pcs

📝 Catatan:
- ${data.catatan}

<i>Mohon Koreksinya, Terimakasih</i> 🙏`
  );
}

function buildCalcResult(stokAwal, orderNum, returNum, bayarNum, kategori = 'Sales') {
  const hargaPerPcs = getHargaPerPcs(kategori);
  const pcsBayar = bayarNum > 0 ? Math.round(bayarNum / hargaPerPcs) : 0;
  const stokAkhir = stokAwal + orderNum - returNum - pcsBayar;

  let bagianRumus = `${formatRibuan(stokAwal)}`;
  if (orderNum > 0) bagianRumus += ` + ${formatRibuan(orderNum)}`;
  if (returNum > 0) bagianRumus += ` - ${formatRibuan(returNum)}`;
  if (pcsBayar > 0) bagianRumus += ` - ${formatRibuan(pcsBayar)}`;
  bagianRumus += ` = ${formatRibuan(stokAkhir)}`;

  return { stokAkhir, bagianRumus, pcsBayar, hargaPerPcs };
}

const session = {};

// ==========================================
// 1. WEB DASHBOARD (EXPRESS)
// ==========================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sales', async (req, res) => {
  try {
    const list = await getSalesWithStock();
    res.json({ success: true, sales: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/transaksi', async (req, res) => {
  try {
    const { sales, order = 0, bayar = 0, retur = 0 } = req.body;
    if (!sales) return res.status(400).json({ success: false, error: 'Nama wajib diisi' });

    const orderNum = parseInt(order, 10) || 0;
    const bayarNum = parseInt(bayar, 10) || 0;
    const returNum = parseInt(retur, 10) || 0;

    const kategori = await getCategoryByName(sales);
    const stokAwal = await getLatestStock(sales);
    const { stokAkhir, bagianRumus } = buildCalcResult(stokAwal, orderNum, returNum, bayarNum, kategori);

    const dataTransaksi = {
      tanggal: getFormattedDate(),
      sales,
      stokAwal,
      order: orderNum,
      retur: returNum,
      bayar: bayarNum,
      stokAkhir,
      catatan: bagianRumus,
      kategori,
    };

    await appendTransaction(dataTransaksi);

    // Kirim laporan Telegram HANYA jika kategori = Sales
    if (kategori.toLowerCase() === 'sales') {
      const laporanText = generateReportText(dataTransaksi);
      if (activeChats.size > 0) {
        for (const chatId of activeChats) {
          try {
            await bot.telegram.sendMessage(chatId, laporanText, { parse_mode: 'HTML' });
          } catch (e) {
            console.warn(`Gagal kirim ke chat ${chatId}:`, e.message);
          }
        }
      }
    }

    res.json({ success: true, data: dataTransaksi, isSales: kategori.toLowerCase() === 'sales' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n======================================================');
  console.log(`🌐 DASHBOARD WEB AKTIF:`);
  console.log(`   👉 Buka di Laptop : http://localhost:${PORT}`);
  console.log(`   👉 Buka di HP (Wi-Fi sama) : http://${LOCAL_IP}:${PORT}`);
  console.log('======================================================\n');
});

// ==========================================
// 2. TELEGRAM BOT (TELEGRAF)
// ==========================================
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const activeChats = new Set();

// Menu Keyboard Utama (Kini ada Total Stok Penjualan)
const MAIN_KEYBOARD = Markup.keyboard([
  ['📦 Input Transaksi', '📋 Cek Stok'],
  ['📊 Total Stok Penjualan', '🌐 Buka Dashboard Web'],
  ['❓ Bantuan']
]).resize();

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  activeChats.add(chatId);
  session[chatId] = {};

  const grouped = await getGroupedStock();
  const salesText = grouped.sales.map(s => `• <b>${s.name}</b>: ${formatRibuan(s.stok)} pcs`).join('\n') || '-';

  await ctx.replyWithHTML(
    `🥐 <b>Selamat datang di Bot Brownis d'mila!</b>\n\n` +
    `📦 <b>Stok Tim Sales:</b>\n${salesText}\n\n` +
    `Total Seluruh Stok Toko: <b>${formatRibuan(grouped.grandTotal)} pcs</b>\n\n` +
    `Silakan pilih menu di bawah ini:`,
    MAIN_KEYBOARD
  );
});

bot.hears(['❓ Bantuan', '/bantuan', '/help'], async (ctx) => {
  await ctx.replyWithHTML(
    `🥖 <b>Panduan Bot Brownis d'mila</b>\n\n` +
    `📦 <b>1. Input Transaksi:</b>\n` +
    `Klik tombol <b>📦 Input Transaksi</b> untuk memilih kategori (Sales / Lapak) dan input step-by-step.\n\n` +
    `📋 <b>2. Cek Stok:</b>\n` +
    `Klik <b>📋 Cek Stok</b> untuk melihat rincian stok Sales & Lapak (urut abjad A-Z) dan total stok hari ini.\n\n` +
    `📊 <b>3. Total Stok Penjualan:</b>\n` +
    `Klik <b>📊 Total Stok Penjualan</b> untuk memilih periode (Hari Ini, 7 Hari, Bulan Ini, Bulan Lalu).\n\n` +
    `⚡ <b>Format Manual Cepat:</b>\n` +
    `<code>!order Asep 300 retur 5 bayar 450000</code>\n` +
    `<code>!bayar Asep 600000</code>\n` +
    `<code>!retur Asep 50</code>`
  );
});

// ==========================================
// MENU: CEK STOK (Urut Abjad Sales & Lapak + Total Hari Ini)
// ==========================================
bot.hears(['📋 Cek Stok', '/stok'], async (ctx) => {
  const grouped = await getGroupedStock();
  const tanggal = getFormattedDateIndo();

  let message = `📋 <b>LAPORAN STOK - ${tanggal}</b>\n\n`;

  // 1. Kategori Sales
  message += `👤 <b>TIM SALES (Urut A-Z):</b>\n`;
  if (grouped.sales.length > 0) {
    grouped.sales.forEach(s => {
      message += `• ${s.name}: <b>${formatRibuan(s.stok)}</b> pcs\n`;
    });
    message += `<i>Subtotal Stok Sales: ${formatRibuan(grouped.totalStokSales)} pcs</i>\n\n`;
  } else {
    message += `<i>(Belum ada data sales)</i>\n\n`;
  }

  // 2. Kategori Lapak
  message += `🏪 <b>OUTLET / LAPAK (Urut A-Z):</b>\n`;
  if (grouped.lapak.length > 0) {
    grouped.lapak.forEach(l => {
      message += `• ${l.name}: <b>${formatRibuan(l.stok)}</b> pcs\n`;
    });
    message += `<i>Subtotal Stok Lapak: ${formatRibuan(grouped.totalStokLapak)} pcs</i>\n\n`;
  } else {
    message += `<i>(Belum ada data lapak)</i>\n\n`;
  }

  // 3. Total Keseluruhan Stok Hari Ini
  message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📦 <b>TOTAL KESELURUHAN STOK HARI INI:</b>\n`;
  message += `👉 <b>${formatRibuan(grouped.grandTotal)} pcs</b>`;

  await ctx.replyWithHTML(message);
});

// ==========================================
// MENU: TOTAL STOK PENJUALAN (PILIHAN PERIODE)
// ==========================================
bot.hears(['📊 Total Stok Penjualan', '/totalstok', '/rekap'], async (ctx) => {
  await ctx.replyWithHTML(
    `📊 <b>Pilih Periode Total Stok Penjualan:</b>\n\n` +
    `Silakan pilih periode untuk melihat total pcs terjual, uang masuk, dan rincian transaksi:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📅 Hari Ini', 'periode:today'),
        Markup.button.callback('📆 7 Hari Terakhir', 'periode:7days')
      ],
      [
        Markup.button.callback('🗓️ Bulan Ini (Okt 2026)', 'periode:this_month'),
        Markup.button.callback('📁 Bulan Lalu', 'periode:last_month')
      ]
    ])
  );
});

bot.action(/^periode:(.+)$/, async (ctx) => {
  const periode = ctx.match[1];
  await ctx.answerCbQuery();

  const now = new Date();
  let startDate = new Date();
  let endDate = new Date();
  let periodeLabel = '';

  if (periode === 'today') {
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    periodeLabel = 'Hari Ini (' + getFormattedDateIndo() + ')';
  } else if (periode === '7days') {
    startDate.setDate(now.getDate() - 7);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    periodeLabel = '7 Hari Terakhir';
  } else if (periode === 'this_month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthName = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    periodeLabel = `Bulan Ini (${monthName})`;
  } else if (periode === 'last_month') {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const monthName = startDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    periodeLabel = `Bulan Lalu (${monthName})`;
  }

  const summary = await getSalesSummaryByPeriod(startDate, endDate);
  if (!summary) {
    await ctx.reply('❌ Gagal memuat data penjualan periode tersebut.');
    return;
  }

  let text = `📊 <b>TOTAL PENJUALAN - ${periodeLabel}</b>\n\n`;
  text += `💵 <b>Total Uang Masuk:</b> Rp ${formatRibuan(summary.totalBayar)}\n`;
  text += `🧁 <b>Total Terjual:</b> <b>${formatRibuan(summary.totalPcsTerjual)} pcs</b>\n`;
  text += `🛒 <b>Total Order:</b> ${formatRibuan(summary.totalOrder)} pcs\n`;
  text += `↩️ <b>Total Retur:</b> ${formatRibuan(summary.totalRetur)} pcs\n\n`;

  text += `👥 <b>Rincian Penjualan per Nama (Terbanyak):</b>\n`;
  if (summary.details.length > 0) {
    summary.details.slice(0, 15).forEach((d, idx) => {
      if (d.pcsTerjual > 0 || d.order > 0) {
        text += `${idx + 1}. <b>${d.nama}</b>: ${formatRibuan(d.pcsTerjual)} pcs terjual (Rp ${formatRibuan(d.bayar)})\n`;
      }
    });
  } else {
    text += `<i>(Belum ada data transaksi pada periode ini)</i>\n`;
  }

  await ctx.replyWithHTML(text);
});

// ==========================================
// DASHBOARD WEB LINK
// ==========================================
bot.hears(['🌐 Buka Dashboard Web', '/dashboard', '!dashboard'], async (ctx) => {
  await ctx.replyWithHTML(
    `🌐 <b>Dashboard Input Brownis d'mila</b>\n\n` +
    `Buka formulir input di browser HP Anda:\n` +
    `👉 http://${LOCAL_IP}:${PORT}\n\n` +
    `<i>Tersedia pilihan filter nama otomatis, order, bayar, dan retur.</i>`
  );
});

// ==========================================
// MENU: INPUT TRANSAKSI (DENGAN KATEGORI SALES / LAPAK)
// ==========================================
bot.hears(['📦 Input Transaksi', '/input'], async (ctx) => {
  const chatId = ctx.chat.id;
  activeChats.add(chatId);
  session[chatId] = { step: 'pilih_kategori' };

  await ctx.replyWithHTML(
    `📂 <b>Pilih Kategori Transaksi:</b>\n\n` +
    `• <b>Sales</b>: Menghasilkan pesan laporan formal ke grup/chat.\n` +
    `• <b>Lapak</b>: Tanpa format laporan panjang, hanya konfirmasi Simpan & Batal.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('👤 Kategori Sales', 'kategori:Sales'),
        Markup.button.callback('🏪 Kategori Lapak', 'kategori:Lapak')
      ]
    ])
  );
});

bot.action(/^kategori:(Sales|Lapak)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const kat = ctx.match[1];
  activeChats.add(chatId);
  await ctx.answerCbQuery();

  session[chatId] = { step: 'pilih_nama', kategori: kat, order: 0, bayar: 0, retur: 0 };

  const grouped = await getGroupedStock();
  const list = kat === 'Sales' ? grouped.sales : grouped.lapak;

  const buttons = list.map(item =>
    Markup.button.callback(`${item.name} (${formatRibuan(item.stok)})`, `nama:${item.name}`)
  );
  buttons.push(Markup.button.callback('➕ Nama Baru...', 'nama:__new__'));

  await ctx.replyWithHTML(
    `👤 <b>Pilih Nama ${kat} (Urut A-Z):</b>`,
    Markup.inlineKeyboard(buttons, { columns: 2 })
  );
});

bot.action(/^nama:(.+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const selected = ctx.match[1];
  activeChats.add(chatId);

  if (!session[chatId]) {
    session[chatId] = { step: 'pilih_nama', kategori: 'Sales' };
  }

  if (selected === '__new__') {
    session[chatId].step = 'nama_baru';
    await ctx.answerCbQuery();
    await ctx.reply('✍️ Ketik nama baru yang ingin dimasukkan:');
    return;
  }

  const stokAwal = await getLatestStock(selected);
  session[chatId] = {
    ...session[chatId],
    step: 'input_order',
    sales: selected,
    stokAwal,
    order: 0,
    bayar: 0,
    retur: 0,
  };

  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `✅ Nama: <b>${selected}</b> [${session[chatId].kategori}]\n` +
    `📦 Stok Awal: <b>${formatRibuan(stokAwal)} pcs</b>\n\n` +
    `🛒 Berapa jumlah <b>Order</b> (pcs)?\n<i>Ketik 0 jika tidak ada order</i>`
  );
});

// Menangkap teks untuk alur percakapan wizard
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  if (session[chatId]?.step) {
    const s = session[chatId];

    if (s.step === 'nama_baru') {
      const stokAwal = await getLatestStock(text);
      session[chatId] = {
        ...s,
        step: 'input_order',
        sales: text,
        stokAwal,
        order: 0,
        bayar: 0,
        retur: 0,
      };
      await ctx.replyWithHTML(
        `✅ Nama: <b>${text}</b> [${s.kategori}]\n\n🛒 Berapa jumlah <b>Order</b> (pcs)?\n<i>Ketik 0 jika tidak ada</i>`
      );
      return;
    }

    if (s.step === 'input_order') {
      const order = parseInt(text, 10) || 0;
      session[chatId] = { ...s, step: 'input_bayar', order };
      await ctx.replyWithHTML(
        `🛒 Order: <b>${formatRibuan(order)} pcs</b>\n\n💵 Berapa nominal <b>Bayar</b> (Rp)?\n<i>Ketik 0 jika tidak ada bayar</i>`
      );
      return;
    }

    if (s.step === 'input_bayar') {
      const bayar = parseInt(text.replace(/[^\d]/g, ''), 10) || 0;
      const hargaPerPcs = getHargaPerPcs(s.kategori);
      const pcsBayar = bayar > 0 ? Math.round(bayar / hargaPerPcs) : 0;
      session[chatId] = { ...s, step: 'input_retur', bayar };
      await ctx.replyWithHTML(
        `💵 Bayar: <b>Rp ${formatRibuan(bayar)}</b> (${formatRibuan(pcsBayar)} pcs terjual @ Rp ${formatRibuan(hargaPerPcs)})\n\n↩️ Berapa jumlah <b>Retur</b> (pcs)?\n<i>Ketik 0 jika tidak ada retur</i>`
      );
      return;
    }

    if (s.step === 'input_retur') {
      const retur = parseInt(text, 10) || 0;
      const { stokAkhir, bagianRumus, pcsBayar, hargaPerPcs } = buildCalcResult(s.stokAwal, s.order, retur, s.bayar, s.kategori);

      session[chatId] = {
        ...s,
        step: 'konfirmasi',
        retur,
        stokAkhir,
        bagianRumus,
      };

      // TAMPILAN SESUAI KEBUTUHAN:
      // Kategori Sales: Pratinjau lengkap format laporan
      // Kategori Lapak: Hanya ringkasan data + Tombol Simpan & Batal
      let previewText = '';
      if (s.kategori === 'Sales') {
        previewText =
          `📋 <b>Pratinjau Laporan Sales:</b>\n\n` +
          `👤 Nama: <b>${s.sales}</b> (Kategori: Sales)\n` +
          `📦 Stok Awal: <b>${formatRibuan(s.stokAwal)} pcs</b>\n` +
          `🛒 Order: <b>${formatRibuan(s.order)} pcs</b>\n` +
          `↩️ Retur: <b>${formatRibuan(retur)} pcs</b>\n` +
          `💵 Bayar: <b>Rp ${formatRibuan(s.bayar)}</b> (${formatRibuan(pcsBayar)} pcs)\n` +
          `📦 Total Stok: <b>${formatRibuan(stokAkhir)} pcs</b>\n\n` +
          `📝 Catatan:\n- ${bagianRumus}\n\n` +
          `Silakan konfirmasi simpan:`;
      } else {
        previewText =
          `🏪 <b>Input Transaksi Lapak:</b>\n\n` +
          `Outlet: <b>${s.sales}</b>\n` +
          `Stok Awal: ${formatRibuan(s.stokAwal)} pcs\n` +
          `Order: ${formatRibuan(s.order)} pcs | Retur: ${formatRibuan(retur)} pcs\n` +
          `Bayar: Rp ${formatRibuan(s.bayar)} (${formatRibuan(pcsBayar)} pcs)\n` +
          `Total Stok Akhir: <b>${formatRibuan(stokAkhir)} pcs</b>\n\n` +
          `<i>(Lapak tidak menghasilkan pesan laporan formal, langsung disimpan ke Spreadsheet).</i>`;
      }

      await ctx.replyWithHTML(
        previewText,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('💾 Simpan', 'konfirmasi:ya'),
            Markup.button.callback('❌ Batal', 'konfirmasi:batal')
          ]
        ])
      );
      return;
    }
  }

  // ==========================================
  // MODE PERINTAH CEPAT TEKS (!order, !bayar, dll)
  // ==========================================
  if (!text.startsWith('!')) return;
  activeChats.add(chatId);

  const [command, ...args] = text.split(/\s+/);
  const cmd = command.toLowerCase();

  try {
    if (cmd === '!stok' || cmd === '!laporan') {
      const targetSales = args[0] && !/\d/.test(args[0]) ? args[0] : null;
      const stok = await getLatestStock(targetSales);
      const nameLabel = targetSales ? ` untuk <b>${targetSales}</b>` : '';
      await ctx.replyWithHTML(
        `📦 Total Stok${nameLabel}: <b>${formatRibuan(stok)} pcs</b>\n📅 ${getFormattedDateIndo()}`
      );
      return;
    }

    if (cmd === '!setstok') {
      const nameSales = args.find(a => !/^\d+$/.test(a));
      const newStockStr = args.find(a => /^\d+$/.test(a));
      const newStock = parseInt(newStockStr, 10);
      if (!newStock) {
        await ctx.reply('⚠️ Format salah. Contoh: !setstok Asep 3046');
        return;
      }
      await setManualStock(newStock);
      await ctx.replyWithHTML(`✅ Stok ${nameSales || ''} diatur menjadi <b>${formatRibuan(newStock)}</b> pcs.`);
      return;
    }

    if (['!bayar', '!retur', '!order', '!input', '!transaksi'].includes(cmd)) {
      let order = 0, retur = 0, bayar = 0;
      let salesName = null;

      const salesMatch = text.match(/(?:sales|nama)\s*[:=]?\s*([a-zA-Z0-9_\-]+)/i);
      if (salesMatch) {
        salesName = salesMatch[1];
      } else {
        const nameToken = args.find(a => !/\d/.test(a) && !['order', 'retur', 'bayar', 'sales', 'nama', 'rp'].includes(a.toLowerCase()));
        if (nameToken) salesName = nameToken;
      }
      if (!salesName) salesName = ctx.from?.first_name || '-';

      const orderMatch = text.match(/order\s*[:=]?\s*([\d\.,]+)/i);
      const returMatch = text.match(/retur\s*[:=]?\s*([\d\.,]+)/i);
      const bayarMatch = text.match(/bayar\s*[:=]?\s*([\d\.,]+)/i);

      if (orderMatch) order = parseInt(orderMatch[1].replace(/[^\d]/g, ''), 10) || 0;
      if (returMatch) retur = parseInt(returMatch[1].replace(/[^\d]/g, ''), 10) || 0;
      if (bayarMatch) bayar = parseInt(bayarMatch[1].replace(/[^\d]/g, ''), 10) || 0;

      const numArgs = args.map(a => parseInt(a.replace(/[^\d]/g, ''), 10)).filter(n => !isNaN(n) && n > 0);
      if (cmd === '!bayar' && bayar === 0 && numArgs.length > 0) bayar = numArgs[0];
      else if (cmd === '!retur' && retur === 0 && numArgs.length > 0) retur = numArgs[0];
      else if (cmd === '!order' && order === 0 && numArgs.length > 0 && !orderMatch) order = numArgs[0];

      if (order === 0 && retur === 0 && bayar === 0) {
        await ctx.reply('⚠️ Nilai tidak terdeteksi.\nContoh: !bayar Asep 600000 atau !order Asep 100');
        return;
      }

      const kategori = await getCategoryByName(salesName);
      const stokAwal = await getLatestStock(salesName);
      const { stokAkhir, bagianRumus } = buildCalcResult(stokAwal, order, retur, bayar, kategori);

      const dataTransaksi = {
        tanggal: getFormattedDate(),
        sales: salesName,
        stokAwal,
        order,
        retur,
        bayar,
        stokAkhir,
        catatan: bagianRumus,
        kategori,
      };

      await appendTransaction(dataTransaksi);

      if (kategori.toLowerCase() === 'sales') {
        await ctx.replyWithHTML(generateReportText(dataTransaksi));
      } else {
        await ctx.replyWithHTML(
          `✅ <b>Data Lapak Tersimpan!</b>\n` +
          `Outlet: <b>${salesName}</b>\n` +
          `Total Stok Akhir: <b>${formatRibuan(stokAkhir)} pcs</b>\n` +
          `<i>(Tersimpan ke Google Sheet)</i>`
        );
      }
    }
  } catch (err) {
    console.error('Error:', err);
    await ctx.reply(`❌ Terjadi kesalahan: ${err.message}`);
  }
});

// ==========================================
// KONFIRMASI SIMPAN ATAU BATAL
// ==========================================
bot.action('konfirmasi:ya', async (ctx) => {
  const chatId = ctx.chat.id;
  const s = session[chatId];
  if (!s || s.step !== 'konfirmasi') {
    await ctx.answerCbQuery('Sesi kedaluwarsa.');
    return;
  }

  try {
    const dataTransaksi = {
      tanggal: getFormattedDate(),
      sales: s.sales,
      stokAwal: s.stokAwal,
      order: s.order,
      retur: s.retur,
      bayar: s.bayar,
      stokAkhir: s.stokAkhir,
      catatan: s.bagianRumus,
      kategori: s.kategori || 'Sales',
    };

    await appendTransaction(dataTransaksi);
    delete session[chatId];

    await ctx.answerCbQuery('✅ Berhasil disimpan!');

    if (dataTransaksi.kategori === 'Sales') {
      // HANYA SALES YANG DIBERIKAN LAPORAN FORMAL
      await ctx.replyWithHTML(generateReportText(dataTransaksi));
    } else {
      // LAPAK HANYA KONFIRMASI TERSIMPAN TANPA LAPORAN FORMAL
      await ctx.replyWithHTML(
        `✅ <b>Data Transaksi Lapak Berhasil Disimpan!</b>\n\n` +
        `🏪 Outlet: <b>${dataTransaksi.sales}</b>\n` +
        `📦 Total Stok Akhir: <b>${formatRibuan(dataTransaksi.stokAkhir)} pcs</b>\n\n` +
        `<i>Data sudah langsung masuk ke Google Sheet.</i>`
      );
    }
  } catch (err) {
    await ctx.answerCbQuery('❌ Gagal');
    await ctx.reply(`❌ Error saat menyimpan: ${err.message}`);
  }
});

bot.action('konfirmasi:batal', async (ctx) => {
  const chatId = ctx.chat.id;
  delete session[chatId];
  await ctx.answerCbQuery('Transaksi Dibatalkan');
  await ctx.reply('❌ <b>Transaksi dibatalkan.</b> Data tidak disimpan ke Spreadsheet.', { parse_mode: 'HTML' });
});

bot.telegram.getMe().then((me) => {
  bot.launch();
  console.log(`✅ Bot Telegram Brownis d'mila sudah aktif! (@${me.username})`);
  console.log('   Cari bot di Telegram dan kirim /start\n');
}).catch((err) => {
  console.error('❌ Gagal menghubungkan ke Telegram:', err.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
