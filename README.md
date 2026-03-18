# DroqsDB Overseas Helper (Torn Userscript)

A lightweight userscript that brings DroqsDB directly into Torn so you can make better travel decisions without leaving the game.

This script shows you what to buy, where to go, and when to do it, all based on real data. It also helps keep that data accurate by contributing price and stock updates automatically in the background.

---

## What This Does

Once installed, the script adds a small companion panel inside Torn that helps you:

- See the best run right now before you travel
- See the best item to buy as soon as you land
- View profit per item, profit per minute, and total run cost
- Use your own settings for capacity, tax, and travel type
- Contribute live pricing and stock data back to DroqsDB automatically

You no longer need to keep droqsdb.com open in another tab or switch between apps.

---

## Features

### Travel Planner
On the travel page, the script shows the most profitable run available at that moment based on your settings.

If you select a destination but have not departed yet, it also shows the best item for that specific country so you can make a quick decision before you fly.

---

### Country Helper
When you are in a foreign country, the panel switches to show the best current item to buy in that country.

This updates based on real data and your saved settings so you can act immediately instead of guessing.

---

### Run Cost
Each recommendation includes the total cost of a full run based on your carrying capacity.

This helps you know exactly how much cash you need to bring without doing the math yourself.

---

### Automatic Data Contribution
While you browse overseas shops, the script quietly submits price and stock data to DroqsDB.

You do not need to do anything. This helps keep the data fresh for everyone using the tool.

---

### Custom Settings
You can control how recommendations are calculated directly inside Torn:

- Sell target (market or Torn)
- Tax handling
- Flight type
- Carrying capacity
- Round trip limits
- Country filters
- Category filters
- Item filters
- Toggle run cost display
- Enable or disable UI elements

All settings are saved and will still be there when you come back later.

---

## Installation

1. Install a userscript manager:
   - Tampermonkey (recommended)
   - Violentmonkey or similar alternatives also work

2. Install the script:
   https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js

3. Open Torn:
   https://www.torn.com

4. The script will activate automatically

---

## How To Use

- Open the travel page to see the best run available
- Select a country to see a country-specific recommendation
- Travel to a country to see the best current item to buy
- Use the gear icon on the panel to adjust your settings
- Drag or minimize the panel to place it wherever you prefer

---

## Notes

- If you see an item with 0 stock, it may still be a valid recommendation. This means it is expected to be in stock by the time you arrive based on timing estimates.
- Settings are stored locally in your browser or TornPDA. They do not sync between devices.
- If you hide the UI, a small launcher remains so you can re-open settings later.

---

## Privacy and Safety

This script does not access your Torn account or personal data.

The only data submitted to DroqsDB is:
- Item name
- Price
- Stock
- Country

No login is required and no personal information is collected.

---

## Why This Exists

DroqsDB was built to make overseas travel more efficient and less guesswork.

This script takes that one step further by bringing the data directly into the game so you can act on it immediately.

---

## Website

https://droqsdb.com

Use the full site for deeper analysis, historical data, and full Top Runs filtering.

---

## Contributing

The easiest way to contribute is simply by using the script while traveling. Every visit helps improve the data for everyone.

---

## Updates

The script updates automatically through your userscript manager when new versions are released.
