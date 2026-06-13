require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Airtable = require('airtable');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;

// ── Airtable table names (must match exactly) ─────────────────────────────────
const T_ORDERS    = 'Purchase Orders';
const T_CUSTOMERS = 'Customers';
const T_LINEITEMS = 'Order Line Items';

// ── Set webhook on startup ────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + '/webhook';
bot.setWebHook(WEBHOOK_URL).then(() => {
  console.log('✅ Webhook set to', WEBHOOK_URL);
});

// ── Telegram webhook endpoint ─────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.message) handleMessage(update.message);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('PawBot is running 🐾'));

// ── Main message handler ──────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id.toString();
  const text   = msg.text || '';
  if (chatId !== GROUP_CHAT_ID) return;

  const classification = await classifyMessage(text);
  if      (classification === 'ORDER_FORM') await handleOrderForm(text);
  else if (classification === 'QUESTION')   await handleQuestion(text);
}

// ── Classify message ──────────────────────────────────────────────────────────
async function classifyMessage(text) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: `Classify this message as ORDER_FORM, QUESTION, or OTHER.
ORDER_FORM = filled cat food order with customer name, address, flavors, total.
QUESTION = question about orders, sales, customers, inventory.
OTHER = everything else.
Reply with ONE word only.\n\nMessage:\n${text}`
    }]
  });
  return res.content[0].text.trim();
}

// ── Handle order form ─────────────────────────────────────────────────────────
async function handleOrderForm(text) {
  try {
    // 1. Ask Claude to extract order data
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are an order assistant for Project Paw, a Malaysian cat food company.
Extract order details and return ONLY valid JSON, no explanation, no markdown.

Products sold (use EXACT item names as shown):
- "Bawk Bawk" mentioned in order → check price:
    RM19 or RM21 → "Bawk Bawk (Chicken) - Starter Promotion" (RM19) or "Bawk Bawk Fresh Chicken Recipe" (RM21)
- "Gulu Gulu" mentioned in order → check price:
    RM28 or RM29 → "Gulu Gulu (Salmon) - Starter Promotion" (RM28) or "Gulu Gulu Fresh Salmon and Chicken Recipe" (RM29)
- If price not clear, default to Starter Promotion prices (RM19 chicken, RM28 salmon)

Return this exact structure:
{
  "customerName": "",
  "contactNumber": "",
  "address": "",
  "state": "",
  "postcode": "",
  "catName": "",
  "collectionMethod": "",
  "items": [
    { "itemName": "Bawk Bawk (Chicken) - Starter Promotion", "quantity": 0, "price": 0 }
  ],
  "deliveryFees": 0,
  "totalAmount": 0,
  "notes": ""
}

Rules:
- collectionMethod: "Courier Required", "Self Pick Up", or "Self Deliver"
- items: one entry per product type ordered, skip if quantity is 0
- price = unit price (number only, no RM)
- deliveryFees and totalAmount = numbers only
- If postcode found in address, extract it
- Detect state from address if not explicitly stated

Order form:
${text}`
      }]
    });

    const order = JSON.parse(res.content[0].text.trim());
    const today = new Date().toISOString().split('T')[0];

    // 2. Find or create customer
    const customerRecId = await findOrCreateCustomer(order);

    // 3. Generate next Order ID
    const nextOrderId = await generateOrderId(order.customerName);

    // 4. Calculate quantities
    // Bawk Bawk = Chicken, Gulu Gulu = Salmon
    const isChicken = (name) => name.toLowerCase().includes('bawk bawk');
    const isSalmon  = (name) => name.toLowerCase().includes('gulu gulu');

    const chickenQty = order.items
      .filter(i => isChicken(i.itemName))
      .reduce((sum, i) => sum + i.quantity, 0);
    const salmonQty = order.items
      .filter(i => isSalmon(i.itemName))
      .reduce((sum, i) => sum + i.quantity, 0);
    const chickenSales = order.items
      .filter(i => isChicken(i.itemName))
      .reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const salmonSales = order.items
      .filter(i => isSalmon(i.itemName))
      .reduce((sum, i) => sum + (i.price * i.quantity), 0);

    // 5. Create Purchase Order
    const poRecord = await base(T_ORDERS).create([{
      fields: {
        'Order Number':       nextOrderId,
        'Customer':           [customerRecId],
        'State':              order.state || '',
        'Postcode':           order.postcode || '',
        'Order Date':         today,
        'Payment Date':       today,
        'Process Status':     'Pending',
        'Collection Method':  order.collectionMethod || 'Courier Required',
        'Payment Method':     'Online',
        'Chicken Quantity':   chickenQty,
        'Salmon Quantity':    salmonQty,
        'Chicken Sales':      chickenSales,
        'Salmon Sales':       salmonSales,
        'Delivery Fees':      order.deliveryFees,
        'Total Amount':       order.totalAmount,
        'Total Quantity':     chickenQty + salmonQty,
        'Temperature Control': 'Frozen',
        'Channel':            'WhatsApp',
        'Notes':              order.notes || 'Pls call customer before arriving',
        'Instructions':       'Pls call customer before arriving'
      }
    }]);

    const poRecId = poRecord[0].id;

    // 6. Create Order Line Items
    for (const item of order.items) {
      await base(T_LINEITEMS).create([{
        fields: {
          'Purchase Orders': [poRecId],
          'Item Name':       item.itemName,
          'Price':           item.price,
          'Quantity':        item.quantity
        }
      }]);
    }

    // 7. Add delivery fee as line item if applicable
    if (order.deliveryFees > 0) {
      await base(T_LINEITEMS).create([{
        fields: {
          'Purchase Orders': [poRecId],
          'Item Name':       'Delivery Fees',
          'Price':           order.deliveryFees,
          'Quantity':        1
        }
      }]);
    }

    // 8. Notify group
    const itemsList = order.items
      .map(i => `• ${i.itemName} x${i.quantity} — RM${(i.price * i.quantity).toFixed(2)}`)
      .join('\n');

    const msg =
`✅ *Order logged!*

🆔 *Order No:* ${nextOrderId}
👤 *Customer:* ${order.customerName}
📞 *Contact:* ${order.contactNumber}
🐱 *Cat:* ${order.catName}
📍 *Address:* ${order.address}

🛍️ *Items:*
${itemsList}
📦 *Delivery:* ${order.deliveryFees === 0 ? 'Free' : 'RM' + order.deliveryFees}
💰 *Total:* RM${order.totalAmount}

_Saved to Airtable ✓_`;

    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Order error:', err);
    await bot.sendMessage(GROUP_CHAT_ID,
      '⚠️ Could not process this order. Please check the format and try again.\n\nError: ' + err.message);
  }
}

// ── Find existing customer or create new one ──────────────────────────────────
async function findOrCreateCustomer(order) {
  // Search by name
  const existing = await base(T_CUSTOMERS).select({
    filterByFormula: `{Name} = '${order.customerName.replace(/'/g, "\\'")}'`,
    maxRecords: 1
  }).all();

  if (existing.length > 0) {
    // Update address/contact if missing
    const rec = existing[0];
    const updates = {};
    if (!rec.get('Contact Number') && order.contactNumber) updates['Contact Number'] = order.contactNumber;
    if (!rec.get('Address') && order.address)               updates['Address'] = order.address;
    if (!rec.get('State') && order.state)                   updates['State'] = order.state;
    if (!rec.get('Postcode') && order.postcode)             updates['Postcode'] = order.postcode;
    if (!rec.get('Pet Name') && order.catName)              updates['Pet Name'] = order.catName;
    if (Object.keys(updates).length > 0) {
      await base(T_CUSTOMERS).update(rec.id, updates);
    }
    return rec.id;
  }

  // Create new customer
  const newCustomer = await base(T_CUSTOMERS).create([{
    fields: {
      'Name':           order.customerName,
      'Contact Number': order.contactNumber || '',
      'Address':        order.address || '',
      'State':          order.state || '',
      'Postcode':       order.postcode || '',
      'Pet Name':       order.catName || '',
      'No. of Pets':    order.catName ? 1 : 0
    }
  }]);
  return newCustomer[0].id;
}

// ── Generate next sequential Order Number ────────────────────────────────────
async function generateOrderId(customerName) {
  const allOrders = await base(T_ORDERS).select({
    fields: ['Order Number'],
    sort: [{ field: 'Order Number', direction: 'desc' }],
    maxRecords: 1
  }).all();

  let nextNum = 1;
  if (allOrders.length > 0) {
    const lastNum = allOrders[0].get('Order Number') || '0';
    const match   = String(lastNum).match(/^(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }

  // Return just the padded number — your Airtable formula adds the customer name
  return String(nextNum).padStart(5, '0');
}

// ── Handle question ───────────────────────────────────────────────────────────
async function handleQuestion(question) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Fetch today's orders
    const todayOrders = await base(T_ORDERS).select({
      filterByFormula: `{Order Date} = '${today}'`,
      sort: [{ field: 'Order Date', direction: 'desc' }]
    }).all();

    // Fetch recent orders (last 30 days)
    const recentOrders = await base(T_ORDERS).select({
      sort: [{ field: 'Order Date', direction: 'desc' }],
      maxRecords: 100
    }).all();

    const toSummary = (records) => records.map(r => ({
      orderId:        r.get('Order ID'),
      customer:       r.get('Customer'),
      date:           r.get('Order Date'),
      status:         r.get('Process Status'),
      chickenQty:     r.get('Chicken Quantity'),
      salmonQty:      r.get('Salmon Quantity'),
      total:          r.get('Total Amount'),
      deliveryFees:   r.get('Delivery Fees'),
      collectionMethod: r.get('Collection Method')
    }));

    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are PawBot, a friendly assistant for Project Paw, a Malaysian cat food company.
Answer concisely using the data below. Use friendly tone, bold with *asterisks*, emoji where helpful.
Today is ${today}.

Question: ${question}

Today's orders:
${JSON.stringify(toSummary(todayOrders), null, 2)}

Recent orders (last 100):
${JSON.stringify(toSummary(recentOrders), null, 2)}`
      }]
    });

    await bot.sendMessage(GROUP_CHAT_ID, res.content[0].text.trim(),
      { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Question error:', err);
    await bot.sendMessage(GROUP_CHAT_ID, '⚠️ Could not fetch data right now. Try again shortly.');
  }
}

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐾 PawBot running on port ${PORT}`));
