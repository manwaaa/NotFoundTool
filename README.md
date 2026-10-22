# NotFoundTool

> **Not Found Rebox Terminal** — Specialized intake & physical box aggregation tool for uncataloged / "Not Found" inventory. Styled to match **iBookTrack**.

![Tech Stack](https://img.shields.io/badge/Stack-HTML5%20%7C%20CSS3%20%7C%20Vanilla%20JS-blue)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen)
![Status](https://img.shields.io/badge/Status-Production%20Ready-success)

---

## 📌 Overview

During warehouse intake operations for projects like **Mustang**, **Jaguar**, and **Journal**, physical books that cannot be found in digital shipment manifests or catalog databases need to be segregated and aggregated into dedicated physical boxes called **Reboxes** (`RB-xxxx`).

**NotFoundTool** provides scan operators and warehouse managers with:
1. **Fast physical barcode intake** with hardware scanner support (`Enter` submit) and camera detection.
2. **Incremental Rebox assignment** (`RB-0001`, `RB-0002`, `RB-0003`...) when sealing a package.
3. **Manager ISBN Tracer**: Instant search to locate which Rebox, lot, and project contains any specific physical ISBN.
4. **Box Inspection & Label Printing**: View complete manifests, print physical box labels, and export CSV reports.

---

## 🚀 Quick Start

**NotFoundTool** requires no build steps, Node modules, or external servers.

### Method 1: Direct File Open
Double-click `index.html` in Windows Explorer or open it in any web browser (`Chrome`, `Edge`, `Firefox`).

### Method 2: Local HTTP Server (Optional)
```bash
# Using Python
python -m http.server 8080

# Using Node / npx
npx serve .
```

### Method 3: Deploy to Vercel or GitHub Pages
The repository includes `vercel.json` for zero-configuration static deployment to Vercel, or can be hosted directly via GitHub Pages.

---

## 🖥️ User Interface & Workflow

The interface follows a streamlined 3-panel workflow matching the warehouse terminal layout:

```
+--------------------------+------------------------------+----------------------------------+
|  1. SETUP & LOT PIPELINE | 2. BARCODE SCANNER TERMINAL  | 3. BOX CONTENTS FEED             |
|                          |                              |                                  |
|  - Select Project        | - Barcode Scanner Input      | - Live feed of scanned books     |
|  - Select Lot Number     | - Mobile Camera Scanner      | - Issue Flagging (Brittle, etc.) |
|  - Active Rebox Card     | - Current Box Counter        | - Remove entry action            |
|  - Search RB in Lot      | - [📦 Assign Box & Close]    | - Sort: Newest / Oldest First    |
|  - Return to Dashboard   | - [➔ Start Next Box]         | - Total counter badge            |
+--------------------------+------------------------------+----------------------------------+
```

### 1. Setup & Lot Pipeline (Column 1)
- **Project Selection**: Choose `Mustang`, `Jaguar`, or `Journal`.
- **Lot Number Selection**: Select active warehouse lots (e.g., `Lot-150`, `Lot-116`, `Lot-113`, `Lot-01`, `Lot-02J`) or enter a custom lot identifier.
- **Active Rebox Package Indicator**: Displays `NOT ASSIGNED (n)` during scanning, updating dynamically to `RB-xxxx (ASSIGNED & CLOSED)` upon closure.
- **Search RB Boxes in Lot**: Rapidly look up and inspect closed boxes within the active project and lot.

### 2. Barcode Scanner Terminal (Column 2)
- **USB / Bluetooth Scanner Support**: Autofocused input listening for rapid `Enter` key events from 1D/2D barcode scanners.
- **Camera Barcode Detection**: Integrated mobile / webcam barcode reader utilizing the browser's native `BarcodeDetector` API.
- **Duplicate Prevention**: Rejects duplicate ISBN scans within the same package.
- **Assign Box No. & Close**: Automatically increments and seals the box with the next Rebox ID (e.g. `RB-0001` &rarr; `RB-0002` &rarr; `RB-0003`...).
- **Start Next Box**: Resets the pending scan session and prepares the scanner for the subsequent box.

### 3. Box Contents Feed (Column 3)
- Real-time list of all scanned books in the current package with sequence numbers (`#1`, `#2`, `#3`...).
- **Defect Flagging**: Tag individual books as `Normal`, `⚠️ Brittle`, `⚠️ Torn Pages`, `⚠️ Stained`, or `🔄 Mismatch`.
- **Item Removal**: Delete accidentally scanned books before box sealing.
- **Sorting Toggle**: Switch between `Newest First` and `Oldest First`.

---

## 🔍 Manager Audit & Tracking Features

### Global ISBN Tracer (`🔍 Trace Any ISBN`)
Managers can type or scan any ISBN into the top navigation tracer modal to immediately retrieve:
- Assigned Rebox number (`RB-xxxx`)
- Associated Project and Lot Number
- Date and time sealed
- Direct link to open the complete box manifest

### Rebox Master Registry (`📋 Rebox Master Registry`)
- Historical log of all closed Rebox packages.
- Filter by Rebox number, Project, or Lot.
- **Bulk CSV Export**: Download complete records of all historical packages.

### Inspection & Box Label Printing
- **Print Box Label**: Generates a standard high-contrast physical box label with oversized `RB-xxxx` typography, lot info, book count, and date.
- **Export CSV**: Download an individual CSV manifest for any specific Rebox package.

---

## 💾 Local Storage Schema

All data persists in the browser via `localStorage`:

| Key | Description |
|---|---|
| `ibooktrack_not_found_reboxes` | Array of closed Rebox objects containing metadata and book lists. |
| `ibooktrack_not_found_rb_counter` | Current highest sequential Rebox number integer. |
| `ibooktrack_not_found_active_session` | Current in-progress session (Project, Lot, pending book list, status). |

---

## 🎨 Design System
Styled in alignment with **iBookTrack**:
- **Palette**: Indigo primary (`#4f46e5`), Slate neutral background (`#f8fafc`), Emerald accents (`#10b981`), Amber warnings (`#f59e0b`).
- **Typography**: Inter for UI controls and JetBrains Mono for ISBNs and box numbers.
- **Audio Feedback**: Built-in POS scanner beeps, success chimes, and alert tones via the Web Audio API without audio file dependencies.
