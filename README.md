# PawBot 🐾

PawBot is an AI-powered Telegram bot for Project Paw — a Malaysian cat fresh food company. It automatically logs order forms to Airtable and answers questions about orders and sales directly in your Telegram group.

## What it does

- Detects when an order form is posted in your Telegram group
- Uses Claude AI to extract order details (customer name, address, items, total)
- Saves the order automatically to Airtable
- Confirms the order in the group with a clean summary
- Answers questions like "orders today?", "total sales this week?", "how many orders pending?"

## Setup

### 1. Environment variables
Copy `.env.example` to `.env` and fill in your keys:

```
TELEGRAM_BOT_TOKEN       — from @BotFather on Telegram
TELEGRAM_GROUP_CHAT_ID   — your order group chat ID (negative number)
CLAUDE_API_KEY           — from console.anthropic.com
AIRTABLE_API_KEY         — from airtable.com/account
AIRTABLE_BASE_ID         — from your Airtable base URL
RENDER_EXTERNAL_URL      — set automatically by Render
```

### 2. Airtable setup
Create a table called `Orders` with these fields:
- Customer Name (Single line text)
- Contact (Phone number)
- Address (Long text)
- Cat Name (Single line text)
- Items (Single line text)
- Shipping Fee (Number)
- Total (RM) (Number)
- Status (Single select: Confirmed, Packed, Shipped, Delivered)
- Date (Date)

### 3. Deploy to Render
1. Push this repo to GitHub
2. Connect GitHub repo to Render as a Web Service
3. Add all environment variables in Render dashboard
4. Deploy

## Order form format
PawBot reads your existing order form format:
```
Name: Aisyah
Contact: 0123456789
Full address: No 12, Jalan xxx
Cat's name: Mochi
Bawk Bawk RM21 x 2
Gulu Gulu RM29 x 1
Shipping fee - RM0
Total RM71
```
