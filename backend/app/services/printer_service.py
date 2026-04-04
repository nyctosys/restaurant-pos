import base64
import io
import re
from escpos.printer import Network, Usb
from app.models import Setting

class PrinterService:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(PrinterService, cls).__new__(cls)
            cls._instance.printer = None
            cls._instance.printer_kind = "receipt"
        return cls._instance

    def _get_printer_config(self, printer_kind="receipt"):
        # Fetch global hardware settings
        setting = Setting.query.filter_by(branch_id=None).first()
        if setting and "hardware" in setting.config:
            hardware = setting.config["hardware"] or {}
            return self._resolve_printer_config(hardware, printer_kind)
        return None

    def _resolve_printer_config(self, hardware, printer_kind):
        kind = "kot" if str(printer_kind).lower() == "kot" else "receipt"
        prefix = "kot_printer" if kind == "kot" else "receipt_printer"

        mode = str(hardware.get(f"{prefix}_mode") or "").strip().lower()
        if mode not in ("usb", "lan"):
            if kind == "receipt":
                mode = str(hardware.get("printer_connection_type") or "").strip().lower()
            if mode not in ("usb", "lan"):
                has_lan = bool(str(hardware.get(f"{prefix}_ip") or "").strip())
                mode = "lan" if has_lan else "usb"

        # KOT falls back to receipt printer if KOT-specific values are empty.
        ip = (
            str(hardware.get(f"{prefix}_ip") or "").strip()
            or str(hardware.get("receipt_printer_ip") or "").strip()
        )
        port_raw = (
            hardware.get(f"{prefix}_port")
            if hardware.get(f"{prefix}_port") not in (None, "")
            else hardware.get("receipt_printer_port")
        )
        try:
            port = int(port_raw or 9100)
        except (TypeError, ValueError):
            port = 9100
        if port <= 0:
            port = 9100

        vendor_id = (
            str(hardware.get(f"{prefix}_vendor_id") or "").strip()
            or str(hardware.get("receipt_printer_vendor_id") or "").strip()
            or str(hardware.get("printer_vendor_id") or "").strip()
        )
        product_id = (
            str(hardware.get(f"{prefix}_product_id") or "").strip()
            or str(hardware.get("receipt_printer_product_id") or "").strip()
            or str(hardware.get("printer_product_id") or "").strip()
        )

        return {
            "mode": mode,
            "ip": ip,
            "port": port,
            "vendor_id": vendor_id,
            "product_id": product_id,
        }

    def connect(self, printer_kind="receipt"):
        config = self._get_printer_config(printer_kind)
        if not config:
            print("Printer hardware not configured in settings.")
            return False

        try:
            self.printer_kind = "kot" if str(printer_kind).lower() == "kot" else "receipt"
            mode = config.get("mode", "usb")

            if mode == "lan":
                host = str(config.get("ip") or "").strip()
                port = int(config.get("port") or 9100)
                if not host:
                    print(f"{self.printer_kind.upper()} LAN printer IP is not configured.")
                    return False
                print(f"Connecting to LAN Printer ({self.printer_kind}: {host}:{port})...")
                self.printer = Network(host=host, port=port)
                self.printer.open()
                return True

            # USB Vendor ID and Product ID (hex strings from settings, e.g. "0x04b8")
            vendor_id = str(config.get("vendor_id") or "").strip()
            product_id = str(config.get("product_id") or "").strip()

            if not vendor_id or not product_id:
                print(f"{self.printer_kind.upper()} USB Vendor ID or Product ID not configured.")
                return False

            # Convert hex string to int (supports "0x04b8" or "04b8" formats)
            vid = int(vendor_id, 16)
            pid = int(product_id, 16)

            print(f"Connecting to USB Printer (VID: {vendor_id}, PID: {product_id})...")
            self.printer = Usb(vid, pid)
            self.printer.open()
            return True
        except Exception as e:
            print(f"Failed to connect to {self.printer_kind} printer: {e}")
            self.printer = None
            return False

    def _disconnect(self):
        """Release USB connection so Windows does not hold the device. Call after each print."""
        if not self.printer:
            return
        try:
            self.printer.close()
        except Exception:
            pass
        try:
            # Release device so next open() can succeed (fixes "access denied" after first print on Windows)
            if getattr(self.printer, "device", None) is not None:
                import usb.util
                usb.util.dispose_resources(self.printer.device)
        except Exception:
            pass
        self.printer = None

    def _kot_printer_buzz(self) -> None:
        """Sound the KOT printer buzzer on ESC/POS models that support it; no-op on failure."""
        if not self.printer:
            return
        try:
            # python-escpos: ESC B n t (beeps × duration); ignored by printers without a buzzer.
            self.printer.buzzer(times=3, duration=5)
        except Exception:
            pass

    def _ensure_connected(self, printer_kind: str, *, fresh: bool = False) -> bool:
        """
        Ensure printer is connected for the requested kind.
        `fresh=True` forces a reconnect to avoid stale OS/device handles between jobs.
        """
        desired_kind = "kot" if str(printer_kind).lower() == "kot" else "receipt"
        if fresh and self.printer:
            self._disconnect()
        elif self.printer and self.printer_kind != desired_kind:
            self._disconnect()

        if self.printer:
            return True
        return self.connect(desired_kind)

    def print_text(self, text):
        if not self._ensure_connected("receipt", fresh=True):
            return False
        
        try:
            self.printer.text(text)
            self.printer.cut()
            self._disconnect()
            return True
        except Exception as e:
            print(f"Printing failed: {e}")
            self._disconnect()
            return False

    def _get_receipt_settings(self, branch_id=None):
        """Load receipt design from settings (global + branch merged)."""
        global_setting = Setting.query.filter_by(branch_id=None).first()
        global_config = (global_setting.config or {}).copy() if global_setting else {}

        if branch_id is not None:
            branch_setting = Setting.query.filter_by(branch_id=branch_id).first()
            if branch_setting and branch_setting.config:
                global_config = {**global_config, **branch_setting.config}

        receipt = global_config.get('receipt_settings') or {}
        branding = global_config.get('branding') or {}
        hardware = global_config.get('hardware') or {}
        return {
            'business_name': (receipt.get('businessName') or '').strip(),
            'business_address': receipt.get('businessAddress') or '',
            'business_phone': receipt.get('businessPhone') or '',
            'footer_message': receipt.get('footerMessage') or branding.get('receipt_footer') or 'Thank you for shopping!',
            'footer_line_1': (receipt.get('footerLine1') or '').strip(),
            'footer_line_2': (receipt.get('footerLine2') or '').strip(),
            'footer_line_3': (receipt.get('footerLine3') or '').strip(),
            'gst_number': (receipt.get('gstNumber') or '').strip(),
            'ntn_number': (receipt.get('ntnNumber') or '').strip(),
            'custom_id_1_label': (receipt.get('customId1Label') or '').strip(),
            'custom_id_1_value': (receipt.get('customId1Value') or '').strip(),
            'custom_id_2_label': (receipt.get('customId2Label') or '').strip(),
            'custom_id_2_value': (receipt.get('customId2Value') or '').strip(),
            'qr_code_content': (receipt.get('qrCodeContent') or '').strip(),
            'tax_rate': global_config.get('tax_rate'),
            'logo_url': receipt.get('logoUrl') or '',
            'paper_width_mm': hardware.get('paper_width', '80mm'),
            'logo_height': max(80, min(250, int(receipt.get('logoHeight') or 140))),
            'header_font_scale': max(1, min(4, int(receipt.get('headerFontScale') or 1))),
            'body_font_scale': max(1, min(4, int(receipt.get('bodyFontScale') or 1))),
            'total_font_scale': max(1, min(4, int(receipt.get('totalFontScale') or 1))),
        }

    def _logo_data_url_to_pil(self, data_url):
        """Decode a data URL (e.g. data:image/png;base64,...) into a PIL Image, or None."""
        m = re.match(r'data:image/(\w+);base64,(.+)', data_url, re.DOTALL)
        if not m:
            return None
        try:
            raw = base64.b64decode(m.group(2))
            from PIL import Image
            return Image.open(io.BytesIO(raw)).convert('RGB')
        except Exception:
            return None

    # Receipt layout: 80mm paper ≈ 48 characters wide
    RECEIPT_WIDTH = 48
    ITEM_COL_WIDTH = 30   # item name + qty
    AMOUNT_COL_WIDTH = 18  # Rs. amount
    HEADER_MARGIN = 2     # character margin left/right for header block (full-width with padding)

    def _set_font_scale(self, scale):
        """Set text size via ESC/POS custom_size (1-4). Scale 1 = normal (clearest), 2 = 2x, etc."""
        scale = max(1, min(4, int(scale)))
        if scale == 1:
            self.printer.set(normal_textsize=True, font='a')
        else:
            self.printer.set(custom_size=True, width=scale, height=scale, font='a')

    def _prepare_logo_for_thermal(self, pil_image, target_width_px, target_height_px):
        """Resize logo to full receipt width and given height; convert to clean 1-bit for thermal."""
        from PIL import Image, ImageFilter
        w, h = pil_image.size
        if w <= 0:
            w = 1
        # Full width; height = min(scale_by_aspect, target_height). Don't upscale tiny images too much.
        new_w = target_width_px
        new_h = min(int(h * target_width_px / w), target_height_px)
        new_h = max(1, new_h)
        resample = getattr(Image, 'Resampling', Image)
        lanczos = getattr(resample, 'LANCZOS', getattr(Image, 'LANCZOS', 1))
        resized = pil_image.resize((new_w, new_h), lanczos)
        gray = resized.convert('L')
        # Slight sharpen for cleaner edges (like reference receipts)
        try:
            gray = gray.filter(ImageFilter.UnsharpMask(radius=1, percent=80, threshold=2))
        except Exception:
            pass
        # Clean 1-bit: threshold 130 gives sharp black/white without muddiness
        binary = gray.point(lambda x: 0 if x < 130 else 255, mode='1')
        return binary

    def print_receipt(self, sale_data):
        if not self._ensure_connected("receipt", fresh=True):
            return False

        settings = self._get_receipt_settings(sale_data.get('branch_id'))
        # Test print: use normal font size so it doesn't print super large
        if sale_data.get('_test_print'):
            settings['header_font_scale'] = 1
            settings['body_font_scale'] = 1
            settings['total_font_scale'] = 1
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        receipt_date = now.strftime('%m/%d/%Y')
        receipt_time = now.strftime('%I:%M %p').lstrip('0')

        items = sale_data.get('items')
        if items is None or not isinstance(items, list):
            items = []
        subtotal = sale_data.get('subtotal')
        if subtotal is None:
            subtotal = sum(
                (item.get('quantity') or 1) * (item.get('unit_price') or 0)
                for item in items
            )
        try:
            subtotal = float(subtotal)
        except (TypeError, ValueError):
            subtotal = 0.0
        tax_amount = sale_data.get('tax_amount')
        tax_rate = sale_data.get('tax_rate')
        total = sale_data.get('total', 0)
        try:
            total = float(total)
        except (TypeError, ValueError):
            total = 0.0
        if tax_amount is None and total is not None:
            tax_amount = total - subtotal
        try:
            tax_amount = float(tax_amount) if tax_amount is not None else 0.0
        except (TypeError, ValueError):
            tax_amount = 0.0
        if tax_rate is None and settings.get('tax_rate') is not None:
            tax_rate = settings['tax_rate']
        if tax_rate is None:
            tax_rate = 0
        try:
            tax_rate = float(tax_rate)
        except (TypeError, ValueError):
            tax_rate = 0.0
        # sale_data sends tax_rate as decimal (e.g. 0.05 for 5%); display as whole number for receipt
        tax_pct = (tax_rate * 100) if 0 <= tax_rate <= 1 else tax_rate
        discount_amount = sale_data.get('discount_amount') or 0
        try:
            discount_amount = float(discount_amount)
        except (TypeError, ValueError):
            discount_amount = 0.0
        delivery_charge = sale_data.get('delivery_charge') or 0
        try:
            delivery_charge = float(delivery_charge)
        except (TypeError, ValueError):
            delivery_charge = 0.0
        service_charge = sale_data.get('service_charge') or 0
        try:
            service_charge = float(service_charge)
        except (TypeError, ValueError):
            service_charge = 0.0
        discount_name = (sale_data.get('discount_name') or 'Discount').strip()

        try:
            # ----- Logo (if set) -----
            logo_url = (settings.get('logo_url') or '').strip()
            if logo_url and logo_url.startswith('data:image'):
                try:
                    pil_image = self._logo_data_url_to_pil(logo_url)
                    if pil_image:
                        paper = settings.get('paper_width_mm', '80mm')
                        target_width = 384 if '80' in paper else 256
                        logo_height = settings.get('logo_height', 140)
                        pil_image = self._prepare_logo_for_thermal(pil_image, target_width, logo_height)
                        self.printer.image(pil_image, center=True, impl='bitImageRaster')
                        self.printer.text("\n")
                except Exception as e:
                    err_msg = str(e).lower()
                    is_usb_error = (
                        'access denied' in err_msg or 'device not found' in err_msg
                        or 'unable to open' in err_msg or 'permission' in err_msg
                        or 'errno 13' in err_msg or 'insufficient' in err_msg
                        or "'nonetype' object has no attribute 'write'" in err_msg
                    )
                    if is_usb_error:
                        print(f"Printer unavailable (USB permission or device): {e}")
                        self._disconnect()
                        return False
                    print(f"Receipt logo skipped: {e}")

            # ----- Header (full width with slight left/right margins) -----
            if self.printer is None:
                return False
            sep = "=" * self.RECEIPT_WIDTH
            thin = "-" * self.RECEIPT_WIDTH
            header_scale = settings.get('header_font_scale', 1)
            body_scale = settings.get('body_font_scale', 1)
            total_scale = settings.get('total_font_scale', 1)
            content_width = self.RECEIPT_WIDTH - 2 * self.HEADER_MARGIN

            # ----- Header block: centered (match settings preview); business name optional -----
            self._set_font_scale(1)
            self._set_font_scale(header_scale)
            business_name = (settings.get('business_name') or '').strip()[:content_width]
            if business_name:
                self.printer.set(align='center', bold=True)
                self.printer.text(business_name + "\n")
                self.printer.set(bold=False)
            self._set_font_scale(1)

            # ----- Body font: address (single line) + phone, centered to match settings -----
            self._set_font_scale(body_scale)
            self.printer.set(align='center')
            addr = (settings['business_address'] or '').strip()
            phone = (settings['business_phone'] or '').strip()
            # Single line: collapse newlines to space so printed receipt matches settings (full-width single line)
            if addr:
                addr_single_line = " ".join(addr.split()).strip()[:content_width]
                self.printer.text(addr_single_line + "\n")
            if phone:
                self.printer.text((phone or "").strip()[:content_width] + "\n")
            self.printer.text(thin + "\n")

            # ----- Transaction info -----
            self.printer.set(align='left')
            op = (sale_data.get('operator') or '').strip()
            branch = (sale_data.get('branch') or '').strip()
            self.printer.text(f"OP: {op}\n")
            self.printer.text(f"Store: {branch}\n")
            dt_line = f"{receipt_date}  {receipt_time}"
            self.printer.text(dt_line.rjust(self.RECEIPT_WIDTH) + "\n")

            order_type_raw = (sale_data.get("order_type") or "").strip().lower()
            if order_type_raw:
                order_labels = {"dine_in": "Dine-in", "delivery": "Delivery", "takeaway": "Takeaway"}
                order_label = order_labels.get(order_type_raw, order_type_raw)
                self.printer.text(f"Order: {order_label}\n")

            self.printer.text(thin + "\n")

            # ----- Item header -----
            self.printer.set(bold=True)
            self.printer.text("Item".ljust(self.ITEM_COL_WIDTH) + "Amount".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            self.printer.set(bold=False)
            self.printer.text(thin + "\n")

            # ----- Items -----
            for item in items:
                title = (item.get('title') or 'Item').strip()
                try:
                    qty = int(item.get('quantity') or 1)
                except (TypeError, ValueError):
                    qty = 1
                try:
                    unit = float(item.get('unit_price') or 0)
                except (TypeError, ValueError):
                    unit = 0.0
                line_total = qty * unit
                name_part = f"{title} x{qty}" if qty != 1 else title
                if len(name_part) > self.ITEM_COL_WIDTH:
                    name_part = name_part[: self.ITEM_COL_WIDTH - 2] + ".."
                amount_str = f"Rs.{line_total:,.0f}"
                self.printer.text(name_part.ljust(self.ITEM_COL_WIDTH) + amount_str.rjust(self.AMOUNT_COL_WIDTH) + "\n")

            self.printer.text(thin + "\n")

            # ----- Totals -----
            self.printer.text("Subtotal".ljust(self.ITEM_COL_WIDTH) + f"Rs.{subtotal:,.0f}".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            if discount_amount > 0:
                label = f"Discount ({discount_name})" if discount_name else "Discount"
                if len(label) > self.ITEM_COL_WIDTH:
                    label = label[: self.ITEM_COL_WIDTH - 2] + ".."
                # Use " - Rs.X" instead of "Rs.-X" to avoid printer firmware issues with minus in amount
                discount_str = f" - Rs.{discount_amount:,.0f}"
                self.printer.text(label.ljust(self.ITEM_COL_WIDTH) + discount_str.rjust(self.AMOUNT_COL_WIDTH) + "\n")
            if service_charge > 0:
                self.printer.text("Service charge".ljust(self.ITEM_COL_WIDTH) + f"Rs.{service_charge:,.0f}".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            if delivery_charge > 0:
                self.printer.text("Delivery charge".ljust(self.ITEM_COL_WIDTH) + f"Rs.{delivery_charge:,.0f}".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            if tax_rate and tax_amount is not None:
                self.printer.text(f"Tax ({tax_pct:.0f}%)".ljust(self.ITEM_COL_WIDTH) + f"Rs.{tax_amount:,.0f}".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            self.printer.text(sep + "\n")
            self._set_font_scale(total_scale)
            self.printer.set(bold=True)
            self.printer.text("TOTAL".ljust(self.ITEM_COL_WIDTH) + f"Rs.{total:,.0f}".rjust(self.AMOUNT_COL_WIDTH) + "\n")
            self.printer.set(bold=False)
            self._set_font_scale(1)
            self.printer.text(sep + "\n")

            # ----- Tax / legal IDs (GST#, NTN#, custom) -----
            self._set_font_scale(body_scale)
            self.printer.set(align='center')
            if settings.get('gst_number'):
                self.printer.text("GST# " + settings['gst_number'] + "\n")
            if settings.get('ntn_number'):
                self.printer.text("NTN# " + settings['ntn_number'] + "\n")
            if settings.get('custom_id_1_label') and settings.get('custom_id_1_value'):
                self.printer.text(settings['custom_id_1_label'] + ": " + settings['custom_id_1_value'] + "\n")
            if settings.get('custom_id_2_label') and settings.get('custom_id_2_value'):
                self.printer.text(settings['custom_id_2_label'] + ": " + settings['custom_id_2_value'] + "\n")
            if any([settings.get('gst_number'), settings.get('ntn_number'),
                    settings.get('custom_id_1_value'), settings.get('custom_id_2_value')]):
                self.printer.text(thin + "\n")

            # ----- Footer -----
            self.printer.text("\n")
            self.printer.set(align='center')
            footer = (settings['footer_message'] or 'Thank you for shopping!').strip()
            self.printer.text(footer + "\n\n")
            for key in ('footer_line_1', 'footer_line_2', 'footer_line_3'):
                line = settings.get(key)
                if line:
                    self.printer.text(line + "\n")
            if settings.get('footer_line_1') or settings.get('footer_line_2') or settings.get('footer_line_3'):
                self.printer.text("\n")

            # ----- QR code (when configured) -----
            qr_content = settings.get('qr_code_content')
            if qr_content:
                try:
                    self.printer.qr(qr_content, center=True, size=4)
                except Exception as e:
                    print(f"Receipt QR code skipped: {e}")

            self.printer.text("\n")
            self.printer.cut()
            self._disconnect()
            return True

        except Exception as e:
            err_msg = str(e).lower()
            self._disconnect()
            if "'nonetype' object has no attribute 'write'" in err_msg or 'access denied' in err_msg or 'usb' in err_msg or 'errno 13' in err_msg:
                print(
                    "Receipt printing failed (USB access). On Windows: install WinUSB for the printer using Zadig "
                    "(https://zadig.akeo.ie), then unplug and replug the printer. Run this app as Administrator if needed."
                )
            else:
                print(f"Receipt printing failed: {e}")
            return False

    def print_kot(self, kot_data: dict) -> bool:
        """Kitchen order ticket for KDS / prep station (no prices, no tax)."""
        if not self._ensure_connected("kot", fresh=True):
            return False
        settings = self._get_receipt_settings(kot_data.get("branch_id"))
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        dt_line = f"{now.strftime('%m/%d/%Y')}  {now.strftime('%I:%M %p').lstrip('0')}"
        sep = "=" * self.RECEIPT_WIDTH
        thin = "-" * self.RECEIPT_WIDTH
        sale_id = kot_data.get("sale_id", "")
        table = (kot_data.get("table_name") or "").strip()
        order_type = (kot_data.get("order_type") or "").strip().lower()
        branch = (kot_data.get("branch") or "").strip()
        operator = (kot_data.get("operator") or "").strip()
        items = kot_data.get("items") or []
        if not isinstance(items, list):
            items = []

        try:
            def _print_kot_item(raw_item, indent=""):
                if not isinstance(raw_item, dict):
                    return
                title = (raw_item.get("title") or raw_item.get("product_title") or "Item").strip()
                try:
                    qty = int(raw_item.get("quantity") or 1)
                except (TypeError, ValueError):
                    qty = 1
                variant = (raw_item.get("variant") or raw_item.get("variant_sku_suffix") or "").strip()
                is_deal = bool(raw_item.get("is_deal"))

                line = f"{indent}{qty}x {title}"
                if is_deal:
                    line = f"{line} [DEAL]"
                if variant:
                    line = f"{line} ({variant})"
                while len(line) > self.RECEIPT_WIDTH:
                    self.printer.text(line[: self.RECEIPT_WIDTH] + "\n")
                    line = line[self.RECEIPT_WIDTH :]
                self.printer.text(line + "\n")

                modifiers = raw_item.get("modifiers") or []
                if isinstance(modifiers, list):
                    for mod in modifiers:
                        if not isinstance(mod, str) or not mod.strip():
                            continue
                        mod_line = f"{indent}  + {mod.strip()}"
                        while len(mod_line) > self.RECEIPT_WIDTH:
                            self.printer.text(mod_line[: self.RECEIPT_WIDTH] + "\n")
                            mod_line = mod_line[self.RECEIPT_WIDTH :]
                        self.printer.text(mod_line + "\n")

                children = raw_item.get("children") or []
                if isinstance(children, list):
                    for child in children:
                        _print_kot_item(child, indent="  ")

            self._set_font_scale(2)
            self.printer.set(align="center", bold=True)
            self.printer.text("KITCHEN ORDER\n")
            self.printer.set(bold=False)
            self._set_font_scale(1)
            self.printer.text(sep + "\n")
            self.printer.set(align="left")
            self.printer.text(f"Order #{sale_id}\n")
            if order_type == "takeaway":
                self.printer.text("Type: Takeaway\n")
            elif order_type == "delivery":
                self.printer.text("Type: Delivery\n")
            elif order_type == "dine_in":
                self.printer.text("Type: Dine-in\n")
            if table:
                self.printer.text(f"Table: {table}\n")
            if branch:
                self.printer.text(f"Store: {branch}\n")
            if operator:
                self.printer.text(f"Server: {operator}\n")
            self.printer.text(dt_line.rjust(self.RECEIPT_WIDTH) + "\n")
            self.printer.text(thin + "\n")
            self.printer.set(bold=True)
            self.printer.text("ITEMS\n")
            self.printer.set(bold=False)
            self.printer.text(thin + "\n")
            for raw in items:
                _print_kot_item(raw)
            self.printer.text(thin + "\n")
            self.printer.set(align="center")
            self.printer.text("— KDS / Prep —\n\n")
            self._kot_printer_buzz()
            self.printer.cut()
            self._disconnect()
            return True
        except Exception as e:
            print(f"KOT printing failed: {e}")
            self._disconnect()
            return False

    def print_barcode_label(self, sku: str, title: str = '') -> bool:
        """Print a barcode label (product name + CODE128) on the configured receipt printer."""
        if not sku or not sku.strip():
            return False
        if not self._ensure_connected("receipt", fresh=True):
            return False
        sku = sku.strip()
        try:
            self.printer.set(align='center')
            if title and title.strip():
                # Product name above barcode (single line, truncated for 48-char width)
                name = (title.strip()[: self.RECEIPT_WIDTH] + '..') if len(title.strip()) > self.RECEIPT_WIDTH else title.strip()
                self.printer.text(name + "\n\n")
            self.printer.barcode(sku, 'CODE128', height=90, width=3, pos='BELOW', align_ct=True)
            self.printer.text("\n")
            self.printer.cut()
            self._disconnect()
            return True
        except Exception as e:
            print(f"Barcode label print failed: {e}")
            self._disconnect()
            return False
