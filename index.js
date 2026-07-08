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

// ── Retry wrapper for Claude API calls ───────────────────────────────────────
// Handles transient network errors like ERR_STREAM_PREMATURE_CLOSE
async function callClaude(params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const isRetryable =
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.message?.includes('Premature close') ||
        err.status === 429 ||
        err.status === 500 ||
        err.status === 502 ||
        err.status === 503 ||
        err.status === 529;

      if (isRetryable && attempt < retries) {
        const waitMs = 1000 * (attempt + 1);
        console.warn(`Claude API call failed (attempt ${attempt + 1}), retrying in ${waitMs}ms:`, err.message);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

// ── Strip markdown code fences from Claude responses before JSON.parse ───────
function stripFences(text) {
  return text.trim().replace(/^```json\n?|^```\n?|\n?```$/g, '').trim();
}

// ── Table names ───────────────────────────────────────────────────────────────
const T_ORDERS        = 'Purchase Orders';
const T_CUSTOMERS     = 'Customers';
const T_LINEITEMS     = 'Order Line Items';
const T_PRODUCTS      = 'Product';
const T_SUBSCRIPTIONS = 'Subscriptions';

// ── Subscription tier config ─────────────────────────────────────────────────
// Matches the Product records: "Monthly Subscription Discount (5%)", etc.
const SUBSCRIPTION_TIERS = {
  'Monthly':  { discountProduct: 'Monthly Subscription Discount (5%)',   percent: 5,  months: 1, recurring: false },
  '3-Month':  { discountProduct: '3-Month Subscription Discount (10%)', percent: 10, months: 3, recurring: true  },
  '6-Month':  { discountProduct: '6-Month Subscription Discount (15%)', percent: 15, months: 6, recurring: true  }
};

// ── 7.7 Sale Promotion config ────────────────────────────────────────────────
// RM7 off orders with a RM100+ product subtotal. Only applies when the order
// mentions the promo (WhatsApp) or uses this discount code (Shopify).
// Ongoing until told otherwise — no expiry date check.
const PROMO_7_7_MIN_SUBTOTAL = 100;
const PROMO_7_7_DISCOUNT     = 7;
const PROMO_7_7_PRODUCT      = '7.7 Sale Discount';
const PROMO_7_7_SHOPIFY_CODE = 'fraaash77sale'; // ⚠️ update this to match the actual code configured in Shopify

// ── Set webhook ───────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + '/webhook';
bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook set to', WEBHOOK_URL))
  .catch(err => {
    // Handle Telegram rate limiting gracefully — webhook is likely already set correctly
    console.warn('⚠️ setWebHook failed (often harmless if already set):', err.message);
  });

// Catch any other unhandled promise rejections so the process doesn't crash
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (caught, not crashing):', reason?.message || reason);
});

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.message) handleMessage(update.message);
});

app.post('/shopify-webhook', (req, res) => {
  res.sendStatus(200); // respond immediately, Shopify requires <5s response
  handleShopifyOrder(req.body).catch(err => console.error('Shopify order error:', err));
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
  const res = await callClaude({
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
    const res = await callClaude({
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

FRAAASH JUNE PAYDAY SALES PROMO (temporary promotion):
- If the message mentions "PAYDAY SALES", "FRAAASH PAYDAY", or "Free Bawk Bawk" with a RM1 charge:
  - Add a line item: { "itemName": "Bawk Bawk Fresh Chicken (June Payday Promo)", "quantity": 1, "price": 0 } for the free box
  - Add a line item: { "itemName": "Payday Sales Top Up", "quantity": 1, "price": 1 } for the RM1 charge
  - These are IN ADDITION to the regular paid items in the order — do not replace or merge them

SUBSCRIPTION PLANS (recurring order plans, separate from the Payday promo):
- Detect if this order is for a subscription plan. Look for words like "subscription", "sub plan", "monthly plan", "recurring order", "Curlec", "auto-debit", an explicit "Monthly / 3-Month / 6-Month" plan mention, OR a discount line that names a percentage matching a tier — e.g. "5% subscription discount", "Promotion 5%", "5% off" — even without the word "subscription" nearby, AS LONG AS the order also has a bulk quantity consistent with that tier (15+ boxes for 5%, 60 packs for 10%/15%).
- Tiers:
  - "Monthly" = 15+ boxes ordered (any chicken/salmon mix), one-time order (not recurring), 5% discount, 1 free delivery
  - "3-Month" = exactly 60 packs ordered per order, recurring via Curlec auto-debit, 10% discount, 1 free delivery
  - "6-Month" = exactly 60 packs ordered per order, recurring via Curlec auto-debit, 15% discount, 1 free delivery
  - When quantity is 60 and it's unclear whether it's 3-Month or 6-Month, use the explicit tier named in the text. Default to "3-Month" if genuinely ambiguous.
- "subscriptionType": set to "Monthly", "3-Month", or "6-Month" if detected, else "" (not a subscription order)
- "subscriptionMonth": the delivery/month number if referenced (e.g. "2nd delivery", "month 3" -> 2, 3). Default to 1 (first delivery / new subscription) if not mentioned

7.7 SALE PROMOTION (ongoing, RM7 off orders RM100+):
- If the message explicitly mentions "7.7", "7.7 Sale", "7.7 Promo", or similar, set "promo77": true
- Do NOT calculate whether the order actually qualifies for the RM100 minimum yourself — just detect whether the promo was mentioned. The bot verifies the RM100 threshold in code.
- Set "promo77": false if not mentioned

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
  "subscriptionType": "",
  "subscriptionMonth": 1,
  "promo77": false,
  "notes": ""
}

Rules:
- catNames: ALL cat names as array, split by comma / "and" / "/"
- collectionMethod: default "Courier Required". Use "Self Pick Up" if pickup mentioned. Use "Self Deliver" if Lalamove/Grab/self deliver mentioned
- collectionDate: expected delivery date as YYYY-MM-DD. Current year is 2026. Always use the explicit DATE NUMBER provided, never infer from day name alone. "Monday 15 June" = 2026-06-15. Leave "" if not mentioned
- paymentMethod: default "Online". Change only if explicitly stated otherwise
- items: one entry per product, skip if quantity 0. Include Payday Sales promo items per the rule above if applicable
- price = unit price as number only
- deliveryFees and totalAmount = numbers only
- Extract postcode from address if present
- Detect state from address if not explicitly stated. Note: "Pulau Pinang" or "P. Pinang" should be normalized to "Penang", "WP Kuala Lumpur" to "Kuala Lumpur", "Malacca" to "Melaka"
- subscriptionType / subscriptionMonth per the SUBSCRIPTION PLANS rule above. Leave subscriptionType "" for normal, non-subscription orders
- promo77: per the 7.7 SALE PROMOTION rule above — true only if explicitly mentioned in the message
- notes: any special instructions. Leave "" if none

Order form:
${text}`
      }]
    });

    // Strip markdown code fences before parsing (Claude sometimes wraps JSON in ```json ... ```)
    const order = JSON.parse(stripFences(res.content[0].text));

    // 2. Prepare cat names + subscription defaults
    const catNamesArr = order.catNames || [];
    order.catNamesStr = catNamesArr.join(', ');
    order.numPets     = catNamesArr.length;
    order.subscriptionType  = SUBSCRIPTION_TIERS[order.subscriptionType] ? order.subscriptionType : '';
    order.subscriptionMonth = Number(order.subscriptionMonth) || 1;
    order.promo77           = order.promo77 === true;

    // 3. Find or create customer
    const customerRecId = await findOrCreateCustomer(order);

    // 3b. Assign the next WhatsApp order number (e.g. 00473)
    const orderNumber = await generateOrderNumber();

    // 4. Create Purchase Order
    const poFields = {
      'Order Number':      orderNumber,
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

    // 6. Delivery fee — subscriptions always get 1 free delivery instead of a paid Delivery Fees line.
    //    Quantity = the RM amount (e.g. RM20 = quantity 20) for the regular, non-subscription case.
    if (order.subscriptionType) {
      const freeDeliveryRec = await findProductByName('Subscription Free Delivery');
      if (freeDeliveryRec) {
        await base(T_LINEITEMS).create([{
          fields: {
            'Purchase Orders': [poRecId],
            'Item Name':       [freeDeliveryRec.id],
            'Quantity':        1
          }
        }]);
      }
    } else if (order.deliveryFees > 0) {
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

    // 6b. Subscription handling: discount line item, Curlec auto-debit flag, Subscriptions record
    let subscriptionRecId = null;
    if (order.subscriptionType) {
      const tier = SUBSCRIPTION_TIERS[order.subscriptionType];

      // Discount applies to the paid product subtotal only (chicken/salmon boxes), not fees/promos
      const productSubtotal = order.items
        .filter(i => /bawk bawk|gulu gulu/i.test(i.itemName))
        .reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
      const discountAmount = Math.round(productSubtotal * tier.percent / 100);

      if (discountAmount > 0) {
        const discountRec = await findProductByName(tier.discountProduct);
        if (discountRec) {
          await base(T_LINEITEMS).create([{
            fields: {
              'Purchase Orders': [poRecId],
              'Item Name':       [discountRec.id],
              'Quantity':        discountAmount
            }
          }]);
        }
      }

      // Recurring plans (3-Month, 6-Month) bill via Curlec auto-debit — log it as a line item flag
      if (tier.recurring) {
        const curlecRec = await findProductByName('Curlec Auto-Debit');
        if (curlecRec) {
          await base(T_LINEITEMS).create([{
            fields: {
              'Purchase Orders': [poRecId],
              'Item Name':       [curlecRec.id],
              'Quantity':        1
            }
          }]);
        }
      }

      // Find or create the Subscriptions record for this customer + tier, and link this PO to it
      subscriptionRecId = await findOrCreateSubscription(order, customerRecId, poRecId, tier, today);
      await base(T_ORDERS).update(poRecId, {
        'Subscription':       [subscriptionRecId],
        'Subscription Month': order.subscriptionMonth
      });
    }

    // 6c. 7.7 Sale Promotion — RM7 off, only if mentioned AND product subtotal >= RM100.
    //     The RM100 threshold is verified here, not trusted from Claude's extraction.
    let promo77Applied = false;
    if (order.promo77) {
      const productSubtotal77 = order.items
        .filter(i => /bawk bawk|gulu gulu/i.test(i.itemName))
        .reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);

      if (productSubtotal77 >= PROMO_7_7_MIN_SUBTOTAL) {
        const promo77Rec = await findProductByName(PROMO_7_7_PRODUCT);
        if (promo77Rec) {
          await base(T_LINEITEMS).create([{
            fields: {
              'Purchase Orders': [poRecId],
              'Item Name':       [promo77Rec.id],
              'Quantity':        PROMO_7_7_DISCOUNT
            }
          }]);
          promo77Applied = true;
        }
      } else {
        console.warn(`7.7 promo mentioned but subtotal RM${productSubtotal77} is below RM${PROMO_7_7_MIN_SUBTOTAL} — not applied.`);
      }
    }

    // 7. Notify group
    const itemsList = order.items
      .map(i => `• ${i.itemName} x${i.quantity} — RM${(i.price * i.quantity).toFixed(2)}`)
      .join('\n');

    const msg = [
      '✅ <b>Order logged!</b>',
      `🆔 <b>Order #:</b> ${orderNumber}`,
      '',
      `👤 <b>Customer:</b> ${order.customerName}`,
      `📞 <b>Contact:</b> ${order.contactNumber}`,
      `🐱 <b>Cat(s):</b> ${order.catNamesStr || '-'}`,
      `📍 <b>Address:</b> ${order.address}`,
      `🚚 <b>Collection:</b> ${poFields['Collection Method']}`,
      `📅 <b>Collection Date:</b> ${order.collectionDate || 'Not specified'}`,
      `💳 <b>Payment:</b> ${poFields['Payment Method']}`,
      order.subscriptionType
        ? `🔁 <b>Subscription:</b> ${order.subscriptionType} — Month ${order.subscriptionMonth}`
        : null,
      promo77Applied ? `🏷️ <b>7.7 Sale:</b> -RM${PROMO_7_7_DISCOUNT} applied` : null,
      '',
      `🛍️ <b>Items:</b>\n${itemsList}`,
      `📦 <b>Delivery Fee:</b> ${order.subscriptionType ? 'Free (Subscription)' : (order.deliveryFees === 0 ? 'Free' : 'RM' + order.deliveryFees)}`,
      `💰 <b>Total:</b> RM${order.totalAmount}`,
      '',
      '<i>Saved to Airtable ✓</i>'
    ].filter(line => line !== null).join('\n');

    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('Order error:', err);

    const isClaudeOutage =
      err.message?.includes('Premature close') ||
      err.message?.includes('Overloaded') ||
      err.status === 529 || err.status === 500 || err.status === 502 || err.status === 503;

    if (isClaudeOutage) {
      await bot.sendMessage(GROUP_CHAT_ID,
        '🔧 <b>Claude AI is temporarily down</b> (Anthropic service issue, not a bot bug).\n\n' +
        '⚠️ This order was NOT saved automatically. Please key it into Airtable manually for now:\n' +
         'https://airtable.com/' + (process.env.AIRTABLE_BASE_ID || '') + '\n\n' +
        'PawBot will resume auto-processing once Claude is back online. Check status.claude.com for updates.',
        { parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(GROUP_CHAT_ID,
        '⚠️ Could not process this order. Please check the format and try again.\n\nError: ' + err.message);
    }
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
    const res = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a data assistant for Project Paw, a Malaysian cat food company.
You MUST respond with ONLY a valid JSON object. No text before or after. No explanation. No markdown. Just the raw JSON.

RULES:
- Questions about deliver/send/fulfill/ship/hantar on a date → filter by collectionDate
- Questions about received/placed/today's orders on a date → filter by Order Date
- Detect if the question asks for a SUMMARY only (e.g. "summary of orders", "summary of sales", "how many orders", "total sales today") vs a DETAILED list (e.g. "list orders", "show orders", "what are the orders to deliver", "give me details")
- If it's a summary-only question, set "summaryOnly": true — but you MUST still include the full matching "orders" array (used internally to calculate accurate totals). The orders just won't be displayed to the user.
- Do NOT calculate or guess the "summary" object yourself — just return the matching orders array accurately. The summary numbers will be calculated separately from your orders list.
- If it's a detailed question, set "summaryOnly": false and include the full "orders" array
- When in doubt (ambiguous question), default to "summaryOnly": false (show full details)
- NEVER respond with plain text. ALWAYS return the JSON structure below
{
  "summaryOnly": false,
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

    let data;
    try {
      data = JSON.parse(stripFences(res.content[0].text));
    } catch (e) {
      await bot.sendMessage(GROUP_CHAT_ID, stripFences(res.content[0].text), { parse_mode: 'HTML' });
      return;
    }

    if (data.noResults || !data.orders || data.orders.length === 0) {
      await bot.sendMessage(GROUP_CHAT_ID,
        data.noResultsMessage || '🔍 No orders found for that criteria.',
        { parse_mode: 'HTML' });
      return;
    }

    // Send each order as its own message — skip entirely if summary-only was requested
    if (!data.summaryOnly && data.orders) {
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
    }

    // Calculate summary numbers ourselves from data.orders — never trust
    // Claude's own arithmetic, to guarantee the summary always matches the list exactly
    const ordersForSummary = data.orders || [];
    const s = {
      totalOrders:      ordersForSummary.length,
      totalChicken:     ordersForSummary.reduce((sum, o) => sum + (Number(o.chickenQty) || 0), 0),
      totalSalmon:      ordersForSummary.reduce((sum, o) => sum + (Number(o.salmonQty) || 0), 0),
      totalRevenue:     ordersForSummary.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
      courierCount:     ordersForSummary.filter(o => o.collectionMethod === 'Courier Required').length,
      selfDeliverCount: ordersForSummary.filter(o => o.collectionMethod === 'Self Deliver').length,
      selfPickUpCount:  ordersForSummary.filter(o => o.collectionMethod === 'Self Pick Up').length
    };

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

// ── Handle Shopify order webhook ──────────────────────────────────────────────
async function handleShopifyOrder(shopifyOrder) {
  try {
    const now    = new Date();
    const myTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today  = myTime.toISOString().split('T')[0];

    // Map Shopify customer + shipping address to our order format
    const shipping = shopifyOrder.shipping_address || {};
    const customer  = shopifyOrder.customer || {};

    const fullName = [shipping.first_name, shipping.last_name].filter(Boolean).join(' ')
                      || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
                      || 'Shopify Customer';

    const addressParts = [
      shipping.address1, shipping.address2, shipping.city,
      shipping.province, shipping.zip
    ].filter(Boolean);
    const fullAddress = addressParts.join(', ');

    const order = {
      customerName:   fullName,
      contactNumber:  shipping.phone || customer.phone || '',
      address:        fullAddress,
      state:          shipping.province || '',
      postcode:       shipping.zip || '',
      catNames:       [],
      catNamesStr:    '',
      numPets:        0
    };

    // Find or create customer in Airtable
    const customerRecId = await findOrCreateCustomer(order);

    // Extract numeric order number from Shopify order name e.g. "SPF1124" -> "1124", "#1124" -> "1124"
    const shopifyOrderName = shopifyOrder.name || String(shopifyOrder.order_number || '');
    const orderNumberMatch = shopifyOrderName.match(/(\d+)/);
    const orderNumber      = orderNumberMatch ? orderNumberMatch[1] : shopifyOrderName;

    // Map Shopify line items to our Product table by matching product title
    const lineItems = shopifyOrder.line_items || [];

    // Detect Fraaash June Payday Sales promo via discount code
    const discountCodes = (shopifyOrder.discount_codes || []).map(d => (d.code || '').toLowerCase());
    const isPaydayPromo = discountCodes.includes('fraaashpayday');

    // Detect 7.7 Sale Promotion via discount code — RM7 off, only applied if product subtotal >= RM100
    const isPromo77Code = discountCodes.includes(PROMO_7_7_SHOPIFY_CODE.toLowerCase());

    // Create Purchase Order
    const poFields = {
      'Order Number':      orderNumber,
      'Customer':          [customerRecId],
      'Order Date':        today,
      'Process Status':    'Pending',
      'Collection Method': 'Courier Required',
      'Payment Method':    'Online',
      'Channel':           'Shopify',
      'Notes':             shopifyOrder.note || ''
    };

    const poRecord = await base(T_ORDERS).create([{ fields: poFields }]);
    const poRecId  = poRecord[0].id;

    // Create Order Line Items — match Shopify product title to Airtable Product
    const matchedItems = [];
    for (const item of lineItems) {
      // Detect the specific Bawk Bawk Chicken line item that has the -RM20 promo discount applied
      const lineDiscount = (item.discount_allocations || [])
        .reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
      const isPromoLine = isPaydayPromo && lineDiscount > 0 &&
                           item.title.toLowerCase().includes('bawk bawk');

      if (isPromoLine && item.quantity > 0) {
        // Split this line: paid units use the normal product, 1 unit is the free promo box
        const paidQty = item.quantity - 1;
        if (paidQty > 0) {
          const productRec = await findProductByName(item.title) || await findProductByNameFuzzy(item.title);
          if (productRec) {
            await base(T_LINEITEMS).create([{
              fields: { 'Purchase Orders': [poRecId], 'Item Name': [productRec.id], 'Quantity': paidQty }
            }]);
            matchedItems.push(`${item.title} x${paidQty}`);
          }
        }
        // The 1 free promo box
        const promoRec = await findProductByName('Bawk Bawk Fresh Chicken (June Payday Promo)');
        if (promoRec) {
          await base(T_LINEITEMS).create([{
            fields: { 'Purchase Orders': [poRecId], 'Item Name': [promoRec.id], 'Quantity': 1 }
          }]);
          matchedItems.push('Bawk Bawk Fresh Chicken (June Payday Promo) x1');
        }
        continue;
      }

      const productRec = await findProductByName(item.title) ||
                          await findProductByNameFuzzy(item.title);
      if (!productRec) {
        console.warn('Shopify product not matched:', item.title);
        continue;
      }
      await base(T_LINEITEMS).create([{
        fields: {
          'Purchase Orders': [poRecId],
          'Item Name':       [productRec.id],
          'Quantity':        item.quantity
        }
      }]);
      matchedItems.push(`${item.title} x${item.quantity}`);
    }

    // Add Payday Sales Top Up line item (the net RM1 the customer paid via the promo)
    if (isPaydayPromo) {
      const topupRec = await findProductByName('Payday Sales Top Up');
      if (topupRec) {
        await base(T_LINEITEMS).create([{
          fields: { 'Purchase Orders': [poRecId], 'Item Name': [topupRec.id], 'Quantity': 1 }
        }]);
        matchedItems.push('Payday Sales Top Up x1');
      }
    }

    // 7.7 Sale Promotion — RM7 off, only if the discount code was used AND product subtotal >= RM100.
    // We verify the RM100 threshold ourselves rather than trusting the discount code alone.
    let promo77Applied = false;
    if (isPromo77Code) {
      const productSubtotal77 = lineItems.reduce(
        (sum, item) => sum + parseFloat(item.price || 0) * (item.quantity || 0), 0);

      if (productSubtotal77 >= PROMO_7_7_MIN_SUBTOTAL) {
        const promo77Rec = await findProductByName(PROMO_7_7_PRODUCT);
        if (promo77Rec) {
          await base(T_LINEITEMS).create([{
            fields: { 'Purchase Orders': [poRecId], 'Item Name': [promo77Rec.id], 'Quantity': PROMO_7_7_DISCOUNT }
          }]);
          matchedItems.push(`${PROMO_7_7_PRODUCT} x${PROMO_7_7_DISCOUNT}`);
          promo77Applied = true;
        }
      } else {
        console.warn(`7.7 promo code used but subtotal RM${productSubtotal77} is below RM${PROMO_7_7_MIN_SUBTOTAL} — not applied.`);
      }
    }

    // Calculate total boxes ordered (chicken + salmon combined) directly from line items
    // 4 or more boxes = free shipping promotion, so skip the Delivery Fees line item entirely
    const totalBoxesOrdered = lineItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const qualifiesForFreeShipping = totalBoxesOrdered >= 4;

    if (!qualifiesForFreeShipping) {
      const shippingTotal = parseFloat(shopifyOrder.total_shipping_price_set?.shop_money?.amount || 0);
      if (shippingTotal > 0) {
        const deliveryRec = await findProductByName('Delivery Fees');
        if (deliveryRec) {
          await base(T_LINEITEMS).create([{
            fields: {
              'Purchase Orders': [poRecId],
              'Item Name':       [deliveryRec.id],
              'Quantity':        Math.round(shippingTotal)
            }
          }]);
        }
      }
    }
    // else: 4+ boxes ordered, free shipping promo applies — no Delivery Fees line item created

    // Notify Telegram group
    const totalAmount = shopifyOrder.total_price || '0.00';
    const msg = [
      '🛒 <b>New Shopify Order!</b>',
      '',
      `🆔 <b>Shopify Order #:</b> ${orderNumber} (${shopifyOrderName})`,
      `👤 <b>Customer:</b> ${order.customerName}`,
      `📞 <b>Contact:</b> ${order.contactNumber || 'N/A'}`,
      `📍 <b>Address:</b> ${order.address || 'N/A'}`,
      '',
      `🛍️ <b>Items:</b>\n${matchedItems.map(i => '• ' + i).join('\n') || 'See Shopify order'}`,
      `💰 <b>Total:</b> RM${totalAmount}`,
      '',
      '<i>Saved to Airtable ✓</i>'
    ].join('\n');

    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('Shopify order processing error:', err);
    await bot.sendMessage(GROUP_CHAT_ID,
      '⚠️ Error processing a Shopify order. Check Render logs.\nError: ' + err.message);
  }
}

// ── Fuzzy product match fallback (for Shopify product name variations) ───────
async function findProductByNameFuzzy(shopifyTitle) {
  const allProducts = await base(T_PRODUCTS).select({ maxRecords: 20 }).all();
  const lower = shopifyTitle.toLowerCase();

  // Try matching by key product words
  if (lower.includes('bawk bawk') || lower.includes('chicken')) {
    return allProducts.find(p => (p.get('Name') || '').toLowerCase().includes('bawk bawk')) || null;
  }
  if (lower.includes('gulu gulu') || lower.includes('salmon')) {
    return allProducts.find(p => (p.get('Name') || '').toLowerCase().includes('gulu gulu')) || null;
  }
  return null;
}

// ── Find or create customer ───────────────────────────────────────────────────
async function findOrCreateCustomer(order) {
  let existing = [];

  // 1. Match by contact number — compare last 9 digits only
  //    Handles +60164152237, 0164152237, (016) 415-2237 all as the same number
  if (order.contactNumber) {
    const digitsOnly = order.contactNumber.replace(/[^0-9]/g, '');
    const last9       = digitsOnly.slice(-9);
    existing = await base(T_CUSTOMERS).select({
      filterByFormula: `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Contact Number}, "+", ""), "-", ""), "(", ""), ")", " "), 9) = "${last9}"`,
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
  // Common alternate names / local spellings that should map to the valid options above
  const stateAliases = {
    'pulau pinang':     'Penang',
    'p. pinang':        'Penang',
    'wp kuala lumpur':  'Kuala Lumpur',
    'wilayah persekutuan kuala lumpur': 'Kuala Lumpur',
    'kl':               'Kuala Lumpur',
    'n. sembilan':      'Negeri Sembilan',
    'n9':               'Negeri Sembilan',
    'malacca':          'Melaka',
    'wp labuan':        'Labuan',
    'wp putrajaya':     'Putrajaya'
  };

  const rawState = (order.state || '').trim().toLowerCase();
  const stateValue =
    validStates.find(s => s.toLowerCase() === rawState) ||
    stateAliases[rawState] ||
    null;

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

// ── Find or create a Subscription record for a customer + tier ───────────────
// Month 1 (new subscription): always creates a fresh Subscriptions record.
// Month 2+ (renewal delivery): looks for the customer's existing Active subscription
// of the same tier and links this new Purchase Order to it instead of creating a duplicate.
async function findOrCreateSubscription(order, customerRecId, poRecId, tier, today) {
  if (order.subscriptionMonth > 1) {
    const activeSubs = await base(T_SUBSCRIPTIONS).select({
      filterByFormula: `AND({Subscription Type} = '${order.subscriptionType}', {Status} = 'Active')`
    }).all();
    const match = activeSubs.find(s => (s.get('Customer') || []).includes(customerRecId));

    if (match) {
      const existingPOs = match.get('Purchase Orders') || [];
      await base(T_SUBSCRIPTIONS).update(match.id, {
        'Purchase Orders': [...existingPOs, poRecId]
      });
      return match.id;
    }
    // No existing active subscription found for a "month 2+" order — fall through and create one
    console.warn(`No active ${order.subscriptionType} subscription found for renewal (month ${order.subscriptionMonth}); creating a new one.`);
  }

  const newSub = await base(T_SUBSCRIPTIONS).create([{
    fields: {
      'Subscription ID':   `${order.customerName} - ${order.subscriptionType} (${today})`,
      'Customer':          [customerRecId],
      'Subscription Type': order.subscriptionType,
      'Status':            'Active',
      'Start Date':        today,
      'Total Months':      tier.months,
      'Discount %':         tier.percent,
      'Purchase Orders':   [poRecId]
    }
  }]);
  return newSub[0].id;
}

// ── Find product by name ──────────────────────────────────────────────────────
async function findProductByName(name) {
  const results = await base(T_PRODUCTS).select({
    filterByFormula: `{Name} = '${name.replace(/'/g, "\\'")}'`,
    maxRecords: 1
  }).all();
  return results.length > 0 ? results[0] : null;
}

// ── Generate next WhatsApp order number ──────────────────────────────────────
// WhatsApp orders use padded 5-digit numbers (e.g. 00472); Shopify orders use
// their own raw numbers, so we only look at Channel = 'FB/Insta' records here
// to avoid mixing the two numbering sequences.
async function generateOrderNumber() {
  const records = await base(T_ORDERS).select({
    filterByFormula: `AND({Channel} = 'FB/Insta', {Order Number} != '')`,
    sort:       [{ field: 'Order Number', direction: 'desc' }],
    maxRecords: 5
  }).all();

  let maxNum = 0;
  for (const r of records) {
    const match = String(r.get('Order Number') || '').match(/^(\d+)/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }
  return String(maxNum + 1).padStart(5, '0');
}

// ── Handle update request ────────────────────────────────────────────────────
async function handleUpdate(text) {
  try {
    const res = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'You are an update assistant for Project Paw. Extract the update and return ONLY valid JSON. '
          + 'Possible tables: Purchase Orders or Customers. '
          + 'Purchase Order fields: Collection Date (YYYY-MM-DD), Process Status (Pending/Packed/Shipped/Delivered/Collected), Collection Method (Courier Required/Self Pick Up/Self Deliver), Notes, Payment Method. '
          + 'Customer fields: Name, Contact Number, Address, Pet Name. '
          + 'Return this structure: {"table":"Purchase Orders","searchField":"Order Number","searchValue":"","updates":{"fieldName":"newValue"}}. '
          + 'If updating by customer name use searchField Customer Name for Purchase Orders or Name for Customers. '
          + 'Always use Order Number (e.g. 00365) as the searchField for Purchase Orders, NOT Order ID. '
          + 'Current year is 2026. '
          + 'Message: ' + text
      }]
    });

    let updateData;
    try {
      updateData = JSON.parse(stripFences(res.content[0].text));
    } catch (e) {
      await bot.sendMessage(GROUP_CHAT_ID, 'Could not understand the update. Example: Update order 00369 collection date to 20 June');
      return;
    }

    const table = updateData.table || 'Purchase Orders';
    // Always use exact string match to avoid collisions between
    // WhatsApp orders (01088) and Shopify orders (1088)
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
