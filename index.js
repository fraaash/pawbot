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
const T_PRODUCTS  = 'Product';

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
  "catNames": [],
  "collectionMethod": "",
  "collectionDate": "",
  "paymentMethod": "",
  "items": [
    { "itemName": "Bawk Bawk (Chicken) - Starter Promotion", "quantity": 0, "price": 0 }
  ],
  "deliveryFees": 0,
  "totalAmount": 0,
  "notes": ""
}

Rules:
- catNames: extract ALL cat names as array, split by comma, "and", or "/". e.g. "Mochi, Ebbi, Money" → ["Mochi", "Ebbi", "Money"]
- collectionMethod: default "Courier Required". Use "Self Pick Up" if they mention pickup/self pickup. Use "Self Deliver" if they mention Lalamove/Grab/self deliver
- collectionDate: the expected delivery/collection date mentioned in the form. Format as YYYY-MM-DD. Leave "" if not mentioned.
  IMPORTANT: Convert day names correctly. The current year is 2026. 
  "Monday 15 June" = 2026-06-15, "Tuesday 16 June" = 2026-06-16.
  Always use the explicit date number if provided — do NOT infer the date from the day name alone.
  If only a day name is given (e.g. "Monday"), leave collectionDate blank.
- paymentMethod: default "Online". Change only if form explicitly states otherwise (e.g. cash)
- items: one entry per product type, skip if quantity 0
- price = unit price as number only (no RM)
- deliveryFees and totalAmount = numbers only
- Extract postcode from address if present
- Detect state from address if not explicitly stated

Order form:
${text}`
      }]
    });

    const order = JSON.parse(res.content[0].text.trim());
    // Use Malaysia time (UTC+8)
    const now = new Date();
    const myTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = myTime.toISOString().split('T')[0];

    // 2. Find or create customer
    // Prepare cat names string and count
    const catNamesArr = order.catNames || (order.catName ? [order.catName] : []);
    const catNamesStr = catNamesArr.join(', ');
    const numPets     = catNamesArr.length;
    order.catNamesStr = catNamesStr;
    order.numPets     = numPets;

    const customerRecId = await findOrCreateCustomer(order);

    // 3. Generate next Order ID
    const nextOrderId = await generateOrderId(order.customerName);

    // 4. (Quantities and sales auto-calculated by Airtable formulas)

    // 5. Create Purchase Order
    // Note: Order Number, Chicken/Salmon Qty, Sales, Delivery Fees,
    // Total Amount, Total Quantity, Instructions are all auto-computed
    // by Airtable formulas — do NOT write to them
    const poFields = {
      'Customer':           [customerRecId],
      'Order Date':         today,
      'Process Status':     'Pending',
      'Collection Method':  ['Self Pick Up', 'Courier Required', 'Self Deliver'].includes(order.collectionMethod)
                            ? order.collectionMethod
                            : 'Courier Required',
      'Payment Method':     ['Online', 'Cash'].includes(order.paymentMethod)
                            ? order.paymentMethod
                            : 'Online',
      'Channel':            'FB/Insta',
      'Notes':              order.notes || ''
    };
    // Only set Collection Date if provided — leave blank otherwise
    if (order.collectionDate) poFields['Collection Date'] = order.collectionDate;

    const poRecord = await base(T_ORDERS).create([{ fields: poFields }]);

    const poRecId = poRecord[0].id;

    // 6. Create Order Line Items
    // 6. Look up Product record IDs and create Order Line Items
    for (const item of order.items) {
      const productRec = await findProductByName(item.itemName);
      if (!productRec) {
        console.warn(`Product not found: ${item.itemName}`);
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

    // 7. Add delivery fee line item only if > RM0
    // Quantity = the RM amount (e.g. RM20 delivery = quantity 20)
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

    // 8. Notify group
    const itemsList = order.items
      .map(i => `• ${i.itemName} x${i.quantity} — RM${(i.price * i.quantity).toFixed(2)}`)
      .join('\n');

    const msg =
`✅ *Order logged!*

🆔 *Order No:* ${nextOrderId}
👤 *Customer:* ${order.customerName}
📞 *Contact:* ${order.contactNumber}
🐱 *Cat(s):* ${(order.catNames || []).join(', ') || '-'}
📍 *Address:* ${order.address}
🚚 *Collection:* ${order.collectionMethod || 'Courier Required'}
📅 *Collection Date:* ${order.collectionDate || 'Not specified'}
💳 *Payment:* ${order.paymentMethod || 'Online'}

🛍️ *Items:*
${itemsList}
📦 *Delivery Fee:* ${order.deliveryFees === 0 ? 'Free' : 'RM' + order.deliveryFees}
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
  let existing = [];

  // 1. Match by contact number first (best for returning customers)
  if (order.contactNumber) {
    const cleaned = order.contactNumber.replace(/[^0-9]/g, '');
    existing = await base(T_CUSTOMERS).select({
      filterByFormula: `FIND("${cleaned}", SUBSTITUTE({Contact Number}, "(", ""))`,
      maxRecords: 1
    }).all();
  }

  // 2. Fall back to name match
  if (existing.length === 0 && order.customerName) {
    existing = await base(T_CUSTOMERS).select({
      filterByFormula: `{Name} = '${order.customerName.replace(/'/g, "\\'")}'`,
      maxRecords: 1
    }).all();
  }

  if (existing.length > 0) {
    const rec = existing[0];
    const updates = {};
    if (!rec.get('Contact Number') && order.contactNumber) updates['Contact Number'] = order.contactNumber;
    if (!rec.get('Address') && order.address)               updates['Address'] = order.address;
    if (!rec.get('Pet Name') && order.catNamesStr)          updates['Pet Name'] = order.catNamesStr;
    if (order.numPets > 0) updates['No. of Pets'] = order.numPets;
    if (Object.keys(updates).length > 0) {
      await base(T_CUSTOMERS).update(rec.id, updates);
    }
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

// ── Find product record by name ──────────────────────────────────────────────
async function findProductByName(name) {
  const results = await base(T_PRODUCTS).select({
    filterByFormula: `{Name} = '${name.replace(/'/g, "\'")}'`,
    maxRecords: 1
  }).all();
  return results.length > 0 ? results[0] : null;
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
    // Use Malaysia time (UTC+8)
    const now = new Date();
    const myTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = myTime.toISOString().split('T')[0];

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
      orderId:          r.get('Order ID'),
      customer:         r.get('Customer'),
      contact:          r.get('Contact Number (from Customer)') || r.get('Contact'),
      address:          r.get('Address (from Customer)') || r.get('Address'),
      date:             r.get('Order Date'),
      collectionDate:   r.get('Collection Date'),
      status:           r.get('Process Status'),
      chickenQty:       r.get('Chicken Quantity'),
      salmonQty:        r.get('Salmon Quantity'),
      total:            r.get('Total Amount'),
      deliveryFees:     r.get('Delivery Fees'),
      collectionMethod: r.get('Collection Method'),
      notes:            r.get('Notes') || ''
    }));

    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are PawBot, a friendly assistant for Project Paw, a Malaysian cat food company.
Answer using the order data below. Format for Telegram mobile — NO tables, use plain text and emoji.

IMPORTANT RULES:
- For questions about orders "to deliver", "to send", "shipment" on a date → filter by collectionDate
- For questions about orders "received", "placed", "today's orders" on a date → filter by date (Order Date)
- Always filter to only show relevant orders based on the question

Format EACH order like this (one blank line between orders):
*[number]. [Order ID]*
👤 [Customer] | 📞 [Contact]
📍 [Address]
🐔 Chicken: [chickenQty] | 🐟 Salmon: [salmonQty]
💰 Total: RM[total]
📦 [Status] | 🚚 [collectionMethod]
📅 Collection Date: [collectionDate]
🗒️ [Notes] *(only include this line if notes is not empty)*

After listing all orders, add this summary block:
───────────────
📊 *Summary*
🧾 Total Orders: [n]
🐔 Total Chicken: [sum]
🐟 Total Salmon: [sum]
💵 Total Revenue: RM[sum]
🚚 Courier Required: [n]
🛵 Self Deliver: [n]
🏪 Self Pick Up: [n]
───────────────

If no orders match, reply friendly that there are no orders for that criteria.
Today is ${today}.

Question: ${question}

Today's orders (filtered by Order Date):
${JSON.stringify(toSummary(todayOrders), null, 2)}

Recent orders (last 100, use this for date/collection date filtering):
${JSON.stringify(toSummary(recentOrders), null, 2)}`
      }]
    });

    // Split reply into chunks to stay within Telegram's 4096 char limit
    await sendChunked(res.content[0].text.trim());

  } catch (err) {
    console.error('Question error:', err);
    await bot.sendMessage(GROUP_CHAT_ID, '⚠️ Could not fetch data right now. Try again shortly.');
  }
}

// ── Send long messages in chunks ─────────────────────────────────────────────
async function sendChunked(text) {
  const MAX = 3800; // safe margin below Telegram's 4096 limit

  if (text.length <= MAX) {
    await bot.sendMessage(GROUP_CHAT_ID, text, { parse_mode: 'Markdown' });
    return;
  }

  // Split on double newline (between orders) to avoid cutting mid-order
  const parts = text.split(/\n\n/);
  let chunk = '';

  for (const part of parts) {
    if ((chunk + '\n\n' + part).length > MAX) {
      if (chunk) {
        await bot.sendMessage(GROUP_CHAT_ID, chunk.trim(), { parse_mode: 'Markdown' });
        chunk = part;
      } else {
        // Single part too long — split by line
        await bot.sendMessage(GROUP_CHAT_ID, part.trim(), { parse_mode: 'Markdown' });
      }
    } else {
      chunk = chunk ? chunk + '\n\n' + part : part;
    }
  }

  // Send remaining chunk
  if (chunk.trim()) {
    await bot.sendMessage(GROUP_CHAT_ID, chunk.trim(), { parse_mode: 'Markdown' });
  }
}

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐾 PawBot running on port ${PORT}`));
