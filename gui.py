#!/usr/bin/env python3
"""
YouTube Music downloader — графічний інтерфейс.

Запуск:
    pythonw gui.py      (без чорного вікна консолі)
    python gui.py

Логіка завантаження (конвертація обкладинки, шаблон імені) живе в start.py —
тут лише інтерфейс, щоб налаштування не розповзались по двох файлах.
"""

import json
import os
import queue
import sys
import threading
import tkinter as tk
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from tkinter import filedialog, messagebox, ttk

# Зібраний з --windowed exe не має консолі: sys.stdout там None, і будь-який
# print зсередини (наш чи з yt-dlp) впав би з AttributeError. Підставляємо
# заглушку ДО імпорту start, бо той на старті чіпає sys.stdout.
if sys.stdout is None or sys.stderr is None:
    _null = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stdout or _null
    sys.stderr = sys.stderr or _null

import yt_dlp

from start import build_opts, find_ffmpeg

MAX_RESULTS = 20        # скільки треків показувати в пошуку
MAX_PLAYLIST = 200      # ліміт треків, коли вставили посилання на альбом/плейлист
ENRICH_WORKERS = 6      # паралельні запити метаданих
def _app_dir():
    """Тека, куди класти settings.json.

    У exe __file__ вказує на тимчасову теку _MEIPASS, яку PyInstaller стирає
    після виходу — налаштування там не пережили б перезапуск. Тому поруч з exe.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


SETTINGS = os.path.join(_app_dir(), "settings.json")


class Stopped(Exception):
    """Користувач натиснув «Стоп»."""


def enable_clipboard(widget):
    """Ctrl+C/V/X/A на будь-якій розкладці.

    Штатні прив'язки tkinter дивляться на символ («v»), а на кириличній
    розкладці приходить «м» — і вставка мовчки не працює. Тому слухаємо
    keycode (це фізична клавіша, від розкладки не залежить).
    """
    keys = {86: "<<Paste>>", 67: "<<Copy>>", 88: "<<Cut>>"}  # V, C, X

    def on_key(event):
        if not (event.state & 0x4):        # чи затиснутий Control
            return None
        if event.keycode == 65:            # A — виділити все
            event.widget.select_range(0, "end")
            event.widget.icursor("end")
            return "break"
        virt = keys.get(event.keycode)
        if virt:
            event.widget.event_generate(virt)
            return "break"
        return None

    widget.bind("<Control-KeyPress>", on_key, add="+")

    # Запасний шлях — права кнопка миші.
    menu = tk.Menu(widget, tearoff=0)
    menu.add_command(label="Вставити", command=lambda: widget.event_generate("<<Paste>>"))
    menu.add_command(label="Копіювати", command=lambda: widget.event_generate("<<Copy>>"))
    menu.add_command(label="Вирізати", command=lambda: widget.event_generate("<<Cut>>"))
    widget.bind("<Button-3>", lambda e: menu.tk_popup(e.x_root, e.y_root))


def looks_like_url(s):
    s = s.lower()
    return s.startswith(("http://", "https://", "www.")) or "youtube.com/" in s or "youtu.be/" in s


def is_song(e):
    """Відсіює канали (UC…), плейлисти (VLPL…) та альбоми (MPREb_…) з видачі.
    У справжнього треку ie_key='Youtube', а id завжди рівно 11 символів."""
    if not e or not e.get("id"):
        return False
    if e.get("ie_key") not in (None, "Youtube"):
        return False
    return len(e["id"]) == 11


def fmt_duration(sec):
    if not sec:
        return ""
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def load_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(data):
    try:
        with open(SETTINGS, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


class App:
    def __init__(self, root):
        self.root = root
        self.ui = queue.Queue()          # повідомлення з фонових потоків у GUI
        self.rows = {}                   # iid -> метадані треку
        # Пошук і завантаження — незалежні: можна качати вже знайдене,
        # поки метадані решти ще довантажуються.
        self.stop_search = threading.Event()
        self.stop_dl = threading.Event()
        self.searching = False
        self.downloading = False
        self.ffmpeg_dir = find_ffmpeg()

        root.title("YouTube Music — завантажувач")
        root.geometry("980x580")
        root.minsize(760, 460)

        self._build_search(root)
        self._build_table(root)
        self._build_bottom(root)

        if not self.ffmpeg_dir:
            self.set_status("FFmpeg не знайдено — завантаження не працюватиме", error=True)

        root.after(80, self._pump)

    # ---------------- побудова інтерфейсу ----------------

    def _build_search(self, root):
        bar = ttk.Frame(root, padding=(10, 10, 10, 4))
        bar.pack(fill="x")

        ttk.Label(bar, text="Пісня або посилання:").pack(side="left")
        self.q = ttk.Entry(bar)
        self.q.pack(side="left", fill="x", expand=True, padx=6)
        self.q.bind("<Return>", lambda _e: self.on_search())
        enable_clipboard(self.q)
        self.q.focus()

        self.search_btn = ttk.Button(bar, text="Шукати", command=self.on_search)
        self.search_btn.pack(side="left")

    def _build_table(self, root):
        wrap = ttk.Frame(root, padding=(10, 4))
        wrap.pack(fill="both", expand=True)

        cols = ("track", "artist", "album", "dur")
        self.tree = ttk.Treeview(wrap, columns=cols, show="headings", selectmode="extended")
        for c, txt, w in (("track", "Назва", 340), ("artist", "Виконавець", 220),
                          ("album", "Альбом", 260), ("dur", "Час", 60)):
            self.tree.heading(c, text=txt)
            self.tree.column(c, width=w, anchor="w" if c != "dur" else "e")

        sb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")

        self.tree.bind("<Double-1>", lambda _e: self.on_download())

    def _build_bottom(self, root):
        cfg = load_settings()
        default_dir = cfg.get("folder") or os.path.join(os.path.expanduser("~"), "Music")

        box = ttk.Frame(root, padding=(10, 4, 10, 10))
        box.pack(fill="x")

        row1 = ttk.Frame(box)
        row1.pack(fill="x", pady=(0, 6))
        ttk.Label(row1, text="Папка:").pack(side="left")
        self.folder = ttk.Entry(row1)
        self.folder.insert(0, default_dir)
        self.folder.pack(side="left", fill="x", expand=True, padx=6)
        enable_clipboard(self.folder)
        ttk.Button(row1, text="Огляд…", command=self.on_browse).pack(side="left")

        row2 = ttk.Frame(box)
        row2.pack(fill="x")
        ttk.Label(row2, text="Формат:").pack(side="left")
        self.fmt = tk.StringVar(value=cfg.get("format", "m4a"))
        ttk.Radiobutton(row2, text="m4a (оригінал)", variable=self.fmt, value="m4a").pack(side="left", padx=4)
        ttk.Radiobutton(row2, text="mp3 (320k)", variable=self.fmt, value="mp3").pack(side="left", padx=4)

        self.dl_btn = ttk.Button(row2, text="Завантажити вибране", command=self.on_download)
        self.dl_btn.pack(side="right")
        self.stop_btn = ttk.Button(row2, text="Стоп", command=self.on_stop, state="disabled")
        self.stop_btn.pack(side="right", padx=6)

        self.bar = ttk.Progressbar(box, mode="determinate", maximum=100)
        self.bar.pack(fill="x", pady=(8, 4))

        self.status = ttk.Label(
            box, text="Введи назву пісні або встав посилання на трек/альбом, тоді «Шукати».",
            anchor="w")
        self.status.pack(fill="x")

    # ---------------- міст між потоками ----------------

    def _pump(self):
        """Єдине місце, де оновлюється GUI. tkinter не можна чіпати з потоків."""
        try:
            while True:
                fn = self.ui.get_nowait()
                try:
                    fn()
                except Exception:
                    pass
        except queue.Empty:
            pass
        self.root.after(80, self._pump)

    def post(self, fn):
        self.ui.put(fn)

    def set_status(self, text, error=False):
        self.status.configure(text=text, foreground="#b00020" if error else "")

    def _refresh(self):
        """Кнопки залежать від двох незалежних станів, а не від одного «busy»."""
        # новий пошук не можна поки якийсь триває або йде завантаження
        self.search_btn.configure(
            state="disabled" if (self.searching or self.downloading) else "normal")
        # качати можна щойно з'явились рядки — чекати на уточнення метаданих не треба
        self.dl_btn.configure(
            state="normal" if (self.rows and not self.downloading) else "disabled")
        self.stop_btn.configure(
            state="normal" if (self.searching or self.downloading) else "disabled")

    # ---------------- пошук ----------------

    def on_search(self):
        q = self.q.get().strip()
        if not q or self.searching or self.downloading:
            return
        self.tree.delete(*self.tree.get_children())
        self.rows.clear()
        self.stop_search.clear()
        self.searching = True
        self._refresh()
        self.bar.configure(mode="indeterminate")
        self.bar.start(12)
        self.set_status(f"Шукаю «{q}»…")
        threading.Thread(target=self._search_worker, args=(q,), daemon=True).start()

    def _search_worker(self, q):
        if looks_like_url(q):
            # Вставили посилання на альбом/плейлист/трек — беремо його як є.
            url = q if q.lower().startswith("http") else "https://" + q
            limit = MAX_PLAYLIST
        else:
            # «#songs» — пошук лише по піснях. Без нього YouTube підмішує канали,
            # плейлисти й альбоми, з яких не зробити посилання watch?v=.
            url = "https://music.youtube.com/search?q=" + urllib.parse.quote(q) + "#songs"
            limit = MAX_RESULTS

        opts = {"quiet": True, "no_warnings": True, "extract_flat": True,
                "playlist_items": f"1-{limit}", "ignoreerrors": True}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                raise Exception("YouTube нічого не повернув")
            if info.get("entries") is not None:          # альбом / плейлист / видача пошуку
                entries = [e for e in info["entries"] if is_song(e)]
                plist = info.get("title")
            else:                                        # одиночний трек за посиланням
                entries = [info] if is_song(info) else []
                plist = None
        except Exception as e:
            self.post(lambda: self._search_failed(str(e)))
            return

        if not entries:
            self.post(lambda: self._search_failed("Нічого не знайдено.", soft=True))
            return

        # Фаза 1: миттєво показуємо назви, щоб не чекати 15 секунд на порожній екран.
        self.post(lambda: self._show_flat(entries, plist))
        # Фаза 2: доганяємо виконавця/альбом/тривалість паралельно.
        threading.Thread(target=self._enrich_worker, args=(entries,), daemon=True).start()

    def _show_flat(self, entries, plist=None):
        self.bar.stop()
        self.bar.configure(mode="determinate", value=0)
        for e in entries:
            iid = e["id"]
            # у видалених треків title = None, але сам рядок показуємо —
            # фаза 2 позначить його як недоступний
            self.rows[iid] = {"id": iid, "track": e.get("title") or "(без назви)",
                              "artist": "…", "album": "", "dur": ""}
            self.tree.insert("", "end", iid=iid,
                             values=(self.rows[iid]["track"], "…", "", ""))
        # рядки вже є — вмикаємо «Завантажити», не чекаючи на фазу 2
        self._refresh()
        what = f"«{plist}» — {len(entries)} трек(ів)" if plist else f"Знайдено {len(entries)}"
        self.set_status(f"{what}. Уточнюю виконавця й альбом (качати можна вже зараз)…")

    def _enrich_worker(self, entries):
        opts = {"quiet": True, "no_warnings": True, "skip_download": True}

        def one(e):
            if self.stop_search.is_set():
                return
            vid = e["id"]
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    d = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            except Exception:
                # Трапляються видалені треки або заблоковані по регіону. Не лишаємо
                # рядок висіти на «…» — краще чесно показати, що він недоступний.
                bad = {"id": vid, "track": e.get("title") or "?",
                       "artist": "— недоступно —", "album": "", "dur": "", "dead": True}
                self.post(lambda: self._update_row(bad))
                return
            artists = d.get("artists") or []
            data = {
                "id": vid,
                "track": d.get("track") or d.get("title") or "?",
                "artist": (artists[0] if artists else None) or d.get("artist") or d.get("uploader") or "",
                "album": d.get("album") or "",
                "dur": fmt_duration(d.get("duration")),
            }
            self.post(lambda: self._update_row(data))

        with ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as pool:
            list(pool.map(one, entries))
        self.post(lambda: self._enrich_done())

    def _update_row(self, d):
        if not self.tree.exists(d["id"]):
            return
        self.rows[d["id"]] = d
        self.tree.item(d["id"], values=(d["track"], d["artist"], d["album"], d["dur"]))

    def _enrich_done(self):
        stopped = self.stop_search.is_set()
        self.searching = False
        self._refresh()
        if stopped:
            self.set_status(f"Пошук зупинено. У списку {len(self.rows)} трек(ів) — качати можна.")
        else:
            self.set_status(f"Готово: {len(self.rows)} треків. Вибери потрібні (Ctrl/Shift) і тисни «Завантажити».")

    def _search_failed(self, msg, soft=False):
        self.bar.stop()
        self.bar.configure(mode="determinate", value=0)
        self.searching = False
        self._refresh()
        self.set_status(msg if soft else f"Помилка пошуку: {msg}", error=not soft)

    # ---------------- завантаження ----------------

    def on_browse(self):
        d = filedialog.askdirectory(title="Куди зберігати", initialdir=self.folder.get() or "/")
        if d:
            self.folder.delete(0, "end")
            self.folder.insert(0, os.path.normpath(d))

    def on_stop(self):
        # Зупиняє те, що зараз працює. Якщо йде і те, й те — зупиняє обидва.
        if self.downloading:
            self.stop_dl.set()
        if self.searching:
            self.stop_search.set()
        self.set_status("Зупиняю…")

    def on_download(self):
        if self.downloading:
            return
        chosen = [self.rows[i] for i in self.tree.selection() if i in self.rows]
        picked = [r for r in chosen if not r.get("dead")]
        skipped = len(chosen) - len(picked)
        if not picked:
            messagebox.showinfo(
                "Нічого не вибрано",
                "Вибери хоча б один доступний трек."
                if skipped else "Спочатку виділи хоча б один трек у списку.")
            return
        if not self.ffmpeg_dir:
            messagebox.showerror("Немає FFmpeg", "FFmpeg не знайдено.\nВстанови: winget install Gyan.FFmpeg")
            return

        out = self.folder.get().strip()
        if not out:
            messagebox.showinfo("Немає папки", "Вкажи папку для збереження.")
            return
        try:
            os.makedirs(out, exist_ok=True)
        except Exception as e:
            messagebox.showerror("Папка недоступна", str(e))
            return

        save_settings({"folder": out, "format": self.fmt.get()})
        self.stop_dl.clear()
        self.downloading = True
        self._refresh()
        threading.Thread(target=self._download_worker,
                         args=(picked, out, self.fmt.get()), daemon=True).start()

    def _download_worker(self, picked, out, fmt):
        total = len(picked)
        done = 0
        failed = []

        def hook(d):
            if self.stop_dl.is_set():
                raise Stopped()
            if d["status"] == "downloading":
                tot = d.get("total_bytes") or d.get("total_bytes_estimate")
                if tot:
                    pct = d.get("downloaded_bytes", 0) / tot * 100
                    self.post(lambda: self.bar.configure(value=pct))
            elif d["status"] == "finished":
                self.post(lambda: self.bar.configure(value=100))
                self.post(lambda: self.set_status("Обробка (обкладинка, теги)…"))

        for item in picked:
            if self.stop_dl.is_set():
                break
            done += 1
            # метадані ще могли не догрузитись — тоді показуємо саму назву
            artist = item["artist"] if item["artist"] not in ("…", "") else ""
            name = f"{artist} — {item['track']}".strip(" —")
            self.post(lambda n=name, i=done: self.set_status(f"[{i}/{total}] {n}"))
            self.post(lambda: self.bar.configure(value=0))

            opts = build_opts(out, fmt, self.ffmpeg_dir, progress_hook=hook)
            # ignoreerrors=False принципово: качаємо по одному треку і хочемо,
            # щоб збій прилетів винятком у except нижче. Інакше помилка мовчки
            # ковтається, і GUI звітує про успіх, не завантаживши файл.
            opts.update({"quiet": True, "no_warnings": True,
                         "noprogress": True, "ignoreerrors": False})
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.download([f"https://www.youtube.com/watch?v={item['id']}"])
            except Stopped:
                break
            except Exception as e:
                failed.append((name, str(e)))

        self.post(lambda: self._download_done(done, total, failed, out))

    def _download_done(self, done, total, failed, out):
        self.downloading = False
        self._refresh()
        self.bar.configure(value=0)
        if self.stop_dl.is_set():
            self.set_status(f"Зупинено. Завантажено {done - len(failed)} з {total}.")
        elif failed:
            self.set_status(f"Завантажено {total - len(failed)} з {total}, помилок: {len(failed)}", error=True)
            messagebox.showwarning("Частина не завантажилась",
                                   "\n\n".join(f"{n}:\n{err}" for n, err in failed[:5]))
        else:
            self.set_status(f"Готово: {total} трек(ів) у {out}")


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
