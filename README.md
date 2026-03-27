
## Running the app (DB in Docker, backend + Tauri on host)

Recommended setup on Windows: database in Docker, backend and frontend run natively so the USB printer works.

1. **Start the database**
   ```bash
   docker-compose up -d
   ```
   **Database not starting on Windows?**
   - Use **Docker Desktop** with the **WSL 2** engine (Settings → General).
   - Ensure **port 5432** is free: in PowerShell run `netstat -ano | findstr ":5432"`. If another PostgreSQL or app is using it, stop it or change the port in `docker-compose.yml` (e.g. `"5433:5432"`) and set `DATABASE_URL` in `backend/.env` to use that host port.
   - If the container exits immediately, check logs: `docker-compose logs database`. If the volume is corrupted, remove it and start fresh: `docker-compose down -v` then `docker-compose up -d` (this deletes existing DB data).
   - The compose file uses the standard `postgres:15` image (not Alpine) and `platform: linux/amd64` for better compatibility on Windows.

2. **Start the backend** (from project root)
   ```bash
   cd backend
   .\venv\Scripts\Activate.ps1   # or: venv\Scripts\activate.bat
   pip install -r requirements.txt
   python run.py
   ```
   The backend uses `backend/.env` (create from `backend/.env.example` if needed). It listens on port **5001**.

   **Production on Windows:** With `FLASK_ENV=production` (or unset `FLASK_DEBUG`), the server runs in production mode: debug off, and **eventlet** (already in requirements) is used for concurrent requests. Gunicorn is not used on Windows; `socketio.run()` with eventlet is the recommended, stable option for Flask-SocketIO on Windows.

3. **Start the desktop app (Tauri)**
   ```bash
   cd frontend
   npm install
   npm run tauri:dev
   ```
   For a production build: `npm run tauri:build`.

To have the backend start automatically after reboot, install it as a Windows service with [NSSM](https://nssm.cc): point NSSM at `backend\venv\Scripts\python.exe` with arguments `run.py` and working directory `backend`.

---

## USB Hardware Setup (Tauri / Production)

Soot Shoot POS runs directly on your local hardware via Tauri desktop deployment, supporting thermal receipt printers and barcode scanners without web browser limitations.

### 1. Barcode Scanner (Keyboard Wedge)
No special drivers are required. Your scanner must be configured to act as a **USB Keyboard** and send a `Carriage Return (Enter)` suffix after scanning. The app has built-in anti-ghosting logic to differentiate between rapid scans and manual typing.

### 2. Thermal Receipt Printer (ESC/POS)
Thermal printers must be connected via USB. The application talks directly to the USB interface using `python-escpos` in the backend API.

You need to input the **USB Vendor ID (VID)** and **Product ID (PID)** into the POS under **Settings → Hardware**.

#### How to find your printer's VID / PID:

**macOS:**
1. Open the Apple Menu > About This Mac > More Info > System Report.
2. Select **USB** under the Hardware section.
3. Find your printer (e.g., EPSON Receipt, POS58).
4. Note the **Vendor ID** (e.g., `0x04b8`) and **Product ID** (e.g., `0x0202`). Enter these exact hex strings in the Settings UI.
*Note: Docker Desktop for Mac does not support direct USB pass-through. Test printing requires running Flask locally (not in Docker), or deploying to Linux.*

**Windows:**
1. Open **Device Manager**.
2. Expand **Universal Serial Bus controllers** or **Printers**.
3. Right-click your printer > Properties > Details tab.
4. Select **Hardware Ids** from the dropdown. 
5. You'll see strings like `USB\VID_04B8&PID_0202`. Your hex values are `0x04b8` and `0x0202`.

**Windows: "Receipt printing failed, no backend available"**  
The backend uses PyUSB, which needs **libusb-1.0** on Windows. Do both steps:

1. **Install libusb-1.0**  
   - Download a Windows build from [libusb releases](https://github.com/libusb/libusb/releases) (e.g. `libusb-1.0.27.7z`).  
   - Extract and copy **`VS2019/MS64/dll/libusb-1.0.dll`** to either:
     - `C:\Windows\System32`, or  
     - the folder that contains your Python executable (e.g. `backend\venv\Scripts\`).  
   - Use the **64-bit** DLL if your Python is 64-bit (default).

2. **Let the app claim the printer (Zadig)**  
   - Install [Zadig](https://zadig.akeo.ie/). Options → List All Devices.  
   - Select your receipt printer (e.g. USB ID 0483 5743).  
   - Choose driver **WinUSB**, then **Replace Driver**.  
   - Unplug and replug the printer, then try Test Print again.

**Linux (Raspberry Pi, Ubuntu etc):**
1. Open Terminal and type `lsusb`.
2. Find the line corresponding to your printer.
3. The format is `ID [VID]:[PID]` (e.g., `ID 04b8:0202 Epson Corp.`).
4. Prepend `0x` to those strings (e.g., `0x04b8`, `0x0202`).
