require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Airtable = require('airtable');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────────────────
const bot        = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const anthropic  = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const base       = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
                     .base(process.env.AIRTABLE_BASE_ID);

const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;

// ── Table names ───────────────────────────────────────────────────────────────
const T_ORDERS    = 'Purchase Orders';
const T_CUSTOMERS = 'Customers';
const T_LINEITEMS = 'Order Line Items';
const T_PRODUCTS  = 'Product';

// ── Set webhook ───────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + '/webhook';
bot.setWebHook(WEBHOOK_URL).then(() => console.log('✅ Webhook set to', WEBHOOK_URL));

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.message) handleMessage(update.message);
});

app.get('/', (req, res) => res.send('PawBot is running 🐾'));

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id.toString();
  const text   = msg.text || '';
  if (chatId !== GROUP_CHAT_ID) return;

  const classification = await classifyMessage(text);
  if      (classification === 'ORDER_FORM') await handleOrderForm(text);
  else if (classification === 'QUESTION')   await handleQuestion(text);
  else if (classification === 'UPDATE')     await handleUpdate(text);
}

// ── Classify ──────────────────────────────────────────────────────────────────
async function classifyMessage(text) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: `Classify this message as ORDER_FORM, QUESTION, UPDATE, or OTHER.
ORDER_FORM = filled cat food order with customer name, address, flavors, total.
QUESTION = question about orders, sales, customers, inventory.
UPDATE = request to change/update/modify an order or customer field e.g. change collection date, update address, mark as packed/shipped/delivered.
OTHER = everything else.
Reply with ONE word only.\n\nMessage:\n${text}`
    }]
  });
  return res.content[0].text.trim();
}

// ── Handle order form ─────────────────────────────────────────────────────────
async function handleOrderForm(text) {
  try {
    // Malaysia time (UTC+8)
    const now    = new Date();
    const myTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today  = myTime.toISOString().split('T')[0];

    // 1. Extract order data with Claude
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are an order assistant for Project Paw, a Malaysian cat food company.
Extract order details and return ONLY valid JSON, no explanation, no markdown.

Products sold (use EXACT item names):
- "Bawk Bawk" at RM19 = "Bawk Bawk (Chicken) - Starter Promotion"
- "Bawk Bawk" at RM21 = "Bawk Bawk Fresh Chicken Recipe"
- "Gulu Gulu" at RM28 = "Gulu Gulu (Salmon) - Starter Promotion"
- "Gulu Gulu" at RM29 = "Gulu Gulu Fresh Salmon and Chicken Recipe"
- Default to Starter Promotion if price unclear

Return this exact structure:
{
  "customerName": "",
  "contactNumber": "",
  "address": "",
  "state": "",
  "postcode": "",
  "catNames": [],
  "collectionMethod": "",
  "collectionDate": "",
  "paymentMethod": "",
  "items": [
    { "itemName": "", "quantity": 0, "price": 0 }
  ],
  "deliveryFees": 0,
  "totalAmount": 0,
  "notes": ""
}

Rules:
- catNames: ALL cat names as array, split by comma / "and" / "/"
- collectionMethod: default "Courier Required". Use "Self Pick Up" if pickup mentioned. Use "Self Deliver" if Lalamove/Grab/self deliver mentioned
- collectionDate: expected delivery date as YYYY-MM-DD. Current year is 2026. Always use the explicit DATE NUMBER provided, never infer from day name alone. "Monday 15 June" = 2026-06-15. Leave "" if not mentioned
- paymentMethod: default "Online". Change only if explicitly stated otherwise
- items: one entry per product, skip if quantity 0
- price = unit price as number only
- deliveryFees and totalAmount = numbers only
- Extract postcode from address if present
- Detect state from address if not explicitly stated
- notes: any special instructions. Leave "" if none

Order form:
${text}`
      }]
    });

    const order = JSON.parse(res.content[0].text.trim());

    // 2. Prepare cat names
    const catNamesArr = order.catNames || [];
    order.catNamesStr = catNamesArr.join(', ');
    order.numPets     = catNamesArr.length;

    // 3. Find or create customer
    const customerRecId = await findOrCreateCustomer(order);

    // 4. Create Purchase Order
    const poFields = {
      'Customer':          [customerRecId],
      'Order Date':        today,
      'Process Status':    'Pending',
      'Collection Method': ['Self Pick Up', 'Courier Required', 'Self Deliver'].includes(order.collectionMethod)
                            ? order.collectionMethod : 'Courier Required',
      'Payment Method':    ['Online', 'Cash'].includes(order.paymentMethod)
                            ? order.paymentMethod : 'Online',
      'Channel':           'FB/Insta',
      'Notes':             order.notes || ''
    };
    if (order.collectionDate) poFields['Collection Date'] = order.collectionDate;

    const poRecord = await base(T_ORDERS).create([{ fields: poFields }]);
    const poRecId  = poRecord[0].id;

    // 5. Create Order Line Items (linked to Product records)
    for (const item of order.items) {
      const productRec = await findProductByName(item.itemName);
      if (!productRec) {
        console.warn('Product not found:', item.itemName);
        continue;
      }
      await base(T_LINEITEMS).create([{
        fields: {
          'Purchase Orders': [poRecId],
          'Item Name':       [productRec.id],
          'Quantity':        item.quantity
        }
      }]);
    }

    // 6. Add delivery fee line item only if > RM0
    //    Quantity = the RM amount (e.g. RM20 = quantity 20)
    if (order.deliveryFees > 0) {
      const deliveryRec = await findProductByName('Delivery Fees');
      if (deliveryRec) {
        await base(T_LINEITEMS).create([{
          fields: {
            'Purchase Orders': [poRecId],
            'Item Name':       [deliveryRec.id],
            'Quantity':        order.deliveryFees
          }
        }]);
      }
    }

    // 7. Notify group
    const itemsList = order.items
      .map(i => `• ${i.itemName} x${i.quantity} — RM${(i.price * i.quantity).toFixed(2)}`)
      .join('\n');

    const msg = [
      '✅ <b>Order logged!</b>',
      '',
      `👤 <b>Customer:</b> ${order.customerName}`,
      `📞 <b>Contact:</b> ${order.contactNumber}`,
      `🐱 <b>Cat(s):</b> ${order.catNamesStr || '-'}`,
      `📍 <b>Address:</b> ${order.address}`,
      `🚚 <b>Collection:</b> ${poFields['Collection Method']}`,
      `📅 <b>Collection Date:</b> ${order.collectionDate || 'Not specified'}`,
      `💳 <b>Payment:</b> ${poFields['Payment Method']}`,
      '',
      `🛍️ <b>Items:</b>\n${itemsList}`,
      `📦 <b>Delivery Fee:</b> ${order.deliveryFees === 0 ? 'Free' : 'RM' + order.deliveryFees}`,
      `💰 <b>Total:</b> RM${order.totalAmount}`,
      '',
      '<i>Saved to Airtable ✓</i>'
    ].join('\n');

    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('Order error:', err);
    await bot.sendMessage(GROUP_CHAT_ID,
      '⚠️ Could not process this order. Please check the format and try again.\n\nError: ' + err.message);
  }
}

// ── Handle question ───────────────────────────────────────────────────────────
async function handleQuestion(question) {
  try {
    const now    = new Date();
    const myTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today  = myTime.toISOString().split('T')[0];

    // Fetch today's orders and recent 100
    const todayOrders = await base(T_ORDERS).select({
      filterByFormula: `{Order Date} = '${today}'`,
      sort: [{ field: 'Order Date', direction: 'desc' }]
    }).all();

    const recentOrders = await base(T_ORDERS).select({
      sort: [{ field: 'Order Date', direction: 'desc' }],
      maxRecords: 100
    }).all();

    // All fields are lookup fields — read directly, no extra API calls
    const enrichOrders = (records) => records.map(r => {
      const getRaw = (field) => {
        const val = r.get(field);
        return Array.isArray(val) ? (val[0] || '') : (val || '');
      };
      return {
        orderId:          r.get('Order ID'),
        customer:         getRaw('Customer Name'),
        contact:          getRaw('Contact'),
        address:          getRaw('Address'),
        date:             r.get('Order Date'),
        collectionDate:   r.get('Collection Date'),
        status:           r.get('Process Status'),
        chickenQty:       r.get('Chicken Quantity') || 0,
        salmonQty:        r.get('Salmon Quantity') || 0,
        total:            r.get('Total Amount') || 0,
        collectionMethod: r.get('Collection Method'),
        notes:            r.get('Notes') || ''
      };
    });

    // Enrich orders with customer contact and address
    const enrichedToday  = enrichOrders(todayOrders);
    const enrichedRecent = enrichOrders(recentOrders);

    // Ask Claude to return structured JSON
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a data assistant for Project Paw, a Malaysian cat food company.
You MUST respond with ONLY a valid JSON object. No text before or after. No explanation. No markdown. Just the raw JSON.

RULES:
- Questions about deliver/send/fulfill/ship/hantar on a date → filter by collectionDate
- Questions about received/placed/today's orders on a date → filter by Order Date  
- For summary questions (how many, total, count) → still return full JSON with matching orders
- NEVER respond with plain text. ALWAYS return the JSON structure below, even for simple count questions
{
  "orders": [
    {
      "orderId": "",
      "customer": "",
      "contact": "",
      "address": "",
      "chickenQty": 0,
      "salmonQty": 0,
      "total": 0,
      "status": "",
      "collectionMethod": "",
      "collectionDate": "",
      "notes": ""
    }
  ],
  "summary": {
    "totalOrders": 0,
    "totalChicken": 0,
    "totalSalmon": 0,
    "totalRevenue": 0,
    "courierCount": 0,
    "selfDeliverCount": 0,
    "selfPickUpCount": 0
  },
  "noResults": false,
  "noResultsMessage": ""
}

Today is ${today}.
Question: ${question}

Today's orders: ${JSON.stringify(enrichedToday)}
Recent orders (last 100): ${JSON.stringify(enrichedRecent)}`
      }]
    });

    let raw = res.content[0].text.trim().replace(/^```json\n?|^```\n?|\n?```$/g, '').trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      await bot.sendMessage(GROUP_CHAT_ID, raw, { parse_mode: 'HTML' });
      return;
    }

    if (data.noResults || !data.orders || data.orders.length === 0) {
      await bot.sendMessage(GROUP_CHAT_ID,
        data.noResultsMessage || '🔍 No orders found for that criteria.',
        { parse_mode: 'HTML' });
      return;
    }

    // Send each order as its own message
    for (let i = 0; i < data.orders.length; i++) {
      const o   = data.orders[i];
      const lines = [
        `<b>${i + 1}. ${o.orderId}</b>`,
        `👤 ${o.customer} | 📞 ${o.contact}`,
        `📍 ${o.address}`,
        `🐔 Chicken: ${o.chickenQty} | 🐟 Salmon: ${o.salmonQty}`,
        `💰 Total: RM${o.total}`,
        `📦 ${o.status} | 🚚 ${o.collectionMethod}`
      ];
      if (o.collectionDate) lines.push(`📅 Collection Date: ${o.collectionDate}`);
      if (o.notes)          lines.push(`🗒️ ${o.notes}`);
      await bot.sendMessage(GROUP_CHAT_ID, lines.join('\n'), { parse_mode: 'HTML' });
    }

    // Send summary as final message
    const s = data.summary;
    const summary = [
      '───────────────',
      '📊 <b>Summary</b>',
      `🧾 Total Orders: ${s.totalOrders}`,
      `🐔 Total Chicken: ${s.totalChicken}`,
      `🐟 Total Salmon: ${s.totalSalmon}`,
      `💵 Total Revenue: RM${s.totalRevenue}`,
      `🚚 Courier Required: ${s.courierCount}`,
      `🛵 Self Deliver: ${s.selfDeliverCount}`,
      `🏪 Self Pick Up: ${s.selfPickUpCount}`,
      '───────────────'
    ].join('\n');
    await bot.sendMessage(GROUP_CHAT_ID, summary, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('Question error:', err);
    await bot.sendMessage(GROUP_CHAT_ID,
      '⚠️ Could not fetch data right now. Try again shortly.');
  }
}

// ── Find or create customer ───────────────────────────────────────────────────
async function findOrCreateCustomer(order) {
  let existing = [];

  // 1. Match by contact number first
  if (order.contactNumber) {
    const cleaned = order.contactNumber.replace(/[^0-9]/g, '');
    existing = await base(T_CUSTOMERS).select({
      filterByFormula: `FIND("${cleaned}", SUBSTITUTE({Contact Number}, "-", ""))`,
      maxRecords: 1
    }).all();
  }

  // 2. Fall back to name
  if (existing.length === 0 && order.customerName) {
    existing = await base(T_CUSTOMERS).select({
      filterByFormula: `{Name} = '${order.customerName.replace(/'/g, "\\'")}'`,
      maxRecords: 1
    }).all();
  }

  if (existing.length > 0) {
    const rec     = existing[0];
    const updates = {};
    if (!rec.get('Contact Number') && order.contactNumber) updates['Contact Number'] = order.contactNumber;
    if (!rec.get('Address') && order.address)               updates['Address']        = order.address;
    if (!rec.get('Pet Name') && order.catNamesStr)          updates['Pet Name']       = order.catNamesStr;
    if (order.numPets > 0)                                  updates['No. of Pets']    = order.numPets;
    if (Object.keys(updates).length > 0) await base(T_CUSTOMERS).update(rec.id, updates);
    return rec.id;
  }

  // New customer
  const validStates = [
    'Selangor', 'Kuala Lumpur', 'Johor', 'Penang', 'Perak',
    'Sabah', 'Sarawak', 'Kedah', 'Kelantan', 'Melaka',
    'Negeri Sembilan', 'Pahang', 'Perlis', 'Terengganu',
    'Putrajaya', 'Labuan'
  ];
  const stateValue = validStates.find(
    s => s.toLowerCase() === (order.state || '').toLowerCase()
  ) || null;

  const newFields = {
    'Name':           order.customerName,
    'Contact Number': order.contactNumber || '',
    'Address':        order.address || '',
    'Pet Name':       order.catNamesStr || '',
    'No. of Pets':    order.numPets || 0
  };
  if (order.postcode) newFields['Postcode'] = order.postcode;
  if (stateValue)     newFields['State']    = stateValue;

  const newCustomer = await base(T_CUSTOMERS).create([{ fields: newFields }]);
  return newCustomer[0].id;
}

// ── Find product by name ──────────────────────────────────────────────────────
async function findProductByName(name) {
  const results = await base(T_PRODUCTS).select({
    filterByFormula: `{Name} = '${name.replace(/'/g, "\\'")}'`,
    maxRecords: 1
  }).all();
  return results.length > 0 ? results[0] : null;
}

// ── Generate next order number ────────────────────────────────────────────────
async function generateOrderId() {
  const allOrders = await base(T_ORDERS).select({
    fields: ['Order Number'],
    sort:   [{ field: 'Order Number', direction: 'desc' }],
    maxRecords: 1
  }).all();

  let nextNum = 1;
  if (allOrders.length > 0) {
    const lastNum = allOrders[0].get('Order Number') || '0';
    const match   = String(lastNum).match(/^(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }
  return String(nextNum).padStart(5, '0');
}

// ── Handle update request ────────────────────────────────────────────────────
async function handleUpdate(text) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'You are an update assistant for Project Paw. Extract the update and return ONLY valid JSON. '
          + 'Possible tables: Purchase Orders or Customers. '
          + 'Purchase Order fields: Collection Date (YYYY-MM-DD), Process Status (Pending/Packed/Shipped/Delivered/Collected), Collection Method (Courier Required/Self Pick Up/Self Deliver), Notes, Payment Method. '
          + 'Customer fields: Name, Contact Number, Address, Pet Name. '
          + 'Return this structure: {"table":"Purchase Orders","searchField":"Order ID","searchValue":"","updates":{"fieldName":"newValue"}}. '
          + 'If updating by customer name use searchField Customer Name for Purchase Orders or Name for Customers. '
          + 'Current year is 2026. '
          + 'Message: ' + text
      }]
    });

    let raw = res.content[0].text.trim().replace(/^```json\n?|^```\n?|\n?```$/g, '').trim();
    let updateData;
    try {
      updateData = JSON.parse(raw);
    } catch (e) {
      await bot.sendMessage(GROUP_CHAT_ID, 'Could not understand the update. Example: Update order 00369 collection date to 20 June');
      return;
    }

    const table   = updateData.table || 'Purchase Orders';
    const formula = '{' + updateData.searchField + '} = \'' + String(updateData.searchValue).replace(/'/g, "\\'") + '\'';
    const records = await base(table).select({ filterByFormula: formula, maxRecords: 1 }).all();

    if (records.length === 0) {
      await bot.sendMessage(GROUP_CHAT_ID,
        '<b>Not found:</b> ' + updateData.searchField + ': ' + updateData.searchValue,
        { parse_mode: 'HTML' });
      return;
    }

    await base(table).update(records[0].id, updateData.updates);

    const changesList = Object.entries(updateData.updates)
      .map(([field, value]) => '• <b>' + field + '</b> → ' + value)
      .join('\n');

    await bot.sendMessage(GROUP_CHAT_ID,
      '✅ <b>Updated!</b>\n\n'
      + updateData.searchField + ': <b>' + updateData.searchValue + '</b>\n\n'
      + changesList + '\n\n<i>Airtable updated ✓</i>',
      { parse_mode: 'HTML' });

  } catch (err) {
    console.error('Update error:', err);
    await bot.sendMessage(GROUP_CHAT_ID, '⚠️ Update failed: ' + err.message);
  }
}

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐾 PawBot running on port ${PORT}`));
