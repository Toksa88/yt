#!/usr/bin/env python3
"""
YouTube Music downloader — качає треки/плейлисти з назвою, автором,
альбомом та вбудованою обкладинкою.

Використання:
    python start.py                      # спитає посилання
    python start.py <url>                # одразу качає
    python start.py <url> -o ./музика    # своя папка
    python start.py <url> -f m4a         # без конвертації (краща якість)

Потрібно:
    pip install yt-dlp
    + FFmpeg (шукається автоматично, або вкажи --ffmpeg <шлях>)
"""

import argparse
import glob
import os
import shutil
import sys

# Консоль Windows за замовчуванням не в UTF-8: кирилиця та символи на кшталт «↓»
# інакше валять скрипт помилкою charmap просто посеред завантаження.
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import yt_dlp
    from yt_dlp.postprocessor import MetadataParserPP
except ImportError:
    sys.exit("Не встановлено yt-dlp. Виконай: pip install yt-dlp")


def find_ffmpeg():
    """Шукає ffmpeg: спершу вшитий в exe, потім у PATH, потім у типових місцях."""
    # У зібраному exe PyInstaller розпаковує ffmpeg.exe у тимчасову теку _MEIPASS.
    # Перевіряємо її ПЕРШОЮ: так програма працює на чужому комп'ютері,
    # де ffmpeg не встановлений.
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        bundled = os.path.join(meipass, "ffmpeg.exe")
        if os.path.isfile(bundled):
            return meipass

    found = shutil.which("ffmpeg")
    if found:
        return os.path.dirname(found)

    patterns = [
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\ffmpeg.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
        os.path.expandvars(r"%ProgramFiles%\ffmpeg\bin\ffmpeg.exe"),
    ]
    for pat in patterns:
        for hit in glob.glob(pat, recursive=True):
            return os.path.dirname(hit)
    return None


def make_progress_hook():
    def hook(d):
        if d["status"] == "downloading":
            pct = d.get("_percent_str", "").strip()
            speed = d.get("_speed_str", "").strip()
            eta = d.get("_eta_str", "").strip()
            title = d.get("info_dict", {}).get("title", "")[:45]
            sys.stdout.write(f"\r  ↓ {title:<45} {pct:>6} {speed:>10} ETA {eta}")
            sys.stdout.flush()
        elif d["status"] == "finished":
            sys.stdout.write("\r" + " " * 90 + "\r")
            print("  ✓ Завантажено, обробка…")
    return hook


def build_opts(out_dir, audio_format, ffmpeg_dir, progress_hook=None):
    postprocessors = []

    if audio_format == "mp3":
        fmt = "bestaudio/best"
        postprocessors.append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "320",
        })
    else:
        # bestaudio часто віддає webm/opus (він виграє за бітрейтом) — а в webm
        # обкладинку вшити НЕ можна, файл так і лишиться .webm з jpg поруч.
        # Тому просимо саме m4a; ffmpeg тоді лише перекладає контейнер (-c copy),
        # без перекодування і без втрати якості.
        fmt = "bestaudio[ext=m4a]/bestaudio/best"
        postprocessors.append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": "m4a",
        })

    postprocessors += [
        # У тег artist YouTube пише всіх виконавців («A, B, B») — саме його показують
        # плеєри й Провідник. Обрізаємо до першого, щоб тег збігався з іменем файлу.
        {"key": "MetadataParser", "when": "pre_process",
         "actions": [(MetadataParserPP.Actions.REPLACE, "artist", r",\s*.+$", "")]},
        # YouTube віддає обкладинки у webp — його не можна вшити ні в mp3, ні в m4a.
        # Конвертуємо в jpg ДО вшивання, інакше файл просто лишається лежати поруч.
        {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
        {"key": "FFmpegMetadata", "add_metadata": True},   # назва, автор, альбом
        {"key": "EmbedThumbnail", "already_have_thumbnail": False},  # обкладинка в файл, webp/jpg прибрати
    ]

    opts = {
        "format": fmt,
        # artist може містити всіх виконавців через кому («A, B, B - Пісня»), тому
        # беремо лише першого зі списку artists. track — чистіша назва за title.
        "outtmpl": os.path.join(out_dir, "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s"),
        "writethumbnail": True,
        "postprocessors": postprocessors,
        "ignoreerrors": True,          # пропускати биті треки в плейлисті
        # YouTube час від часу віддає 403 на потік — це плаваюча помилка,
        # яка зазвичай зникає з другої спроби. Без ретраїв трек просто губиться.
        "retries": 10,
        "fragment_retries": 10,
        "extractor_retries": 3,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,      # прибрати : ? * тощо з назв
        "progress_hooks": [progress_hook or make_progress_hook()],
        # обрізати обкладинку до квадрата (гарніше в плеєрах)
        "postprocessor_args": {"embedthumbnail+ffmpeg_o": ["-c:v", "mjpeg", "-vf", "crop=ih:ih"]},
    }
    if ffmpeg_dir:
        opts["ffmpeg_location"] = ffmpeg_dir
    return opts


def download(url, out_dir, audio_format, ffmpeg_dir):
    os.makedirs(out_dir, exist_ok=True)
    opts = build_opts(out_dir, audio_format, ffmpeg_dir)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        entries = info.get("entries") if info else None

        if entries is not None:
            entries = [e for e in entries if e]
            print(f"Плейлист: «{info.get('title', '?')}» — {len(entries)} треків\n")
        else:
            print(f"Один трек: {info.get('title', '?') if info else '?'}\n")

        # ignoreerrors=True потрібен, щоб битий трек не вбивав увесь плейлист,
        # але тоді помилки не летять винятком — про них скаже лише код повернення.
        # Без цієї перевірки скрипт бадьоро писав «Готово», не завантаживши нічого.
        ret = ydl.download([url])

    if ret:
        print(f"\nЧастина треків НЕ завантажилась (код {ret}).")
        print("Найчастіше це тимчасовий 403 від YouTube — просто запусти ще раз.")
    else:
        print(f"\nГотово. Файли в: {os.path.abspath(out_dir)}")


def main():
    p = argparse.ArgumentParser(description="Завантажувач з YouTube Music")
    p.add_argument("url", nargs="?", help="Посилання на трек або плейлист")
    p.add_argument("-o", "--output", default="downloads", help="Папка (за замовч. downloads)")
    p.add_argument("-f", "--format", choices=["mp3", "m4a"], default="mp3",
                   help="mp3 (320k) або m4a (оригінал, краща якість/швидше)")
    p.add_argument("--ffmpeg", help="Шлях до папки з ffmpeg (якщо не знайшовся сам)")
    args = p.parse_args()

    ffmpeg_dir = args.ffmpeg or find_ffmpeg()
    if not ffmpeg_dir:
        sys.exit(
            "FFmpeg не знайдено.\n"
            "  Встанови:  winget install Gyan.FFmpeg\n"
            "  Або вкажи: python start.py <url> --ffmpeg C:\\шлях\\до\\bin"
        )

    url = args.url or input("Встав посилання на трек/плейлист: ").strip()
    if not url:
        sys.exit("Посилання не вказано.")

    try:
        download(url, args.output, args.format, ffmpeg_dir)
    except KeyboardInterrupt:
        sys.exit("\nПерервано користувачем.")
    except Exception as e:
        sys.exit(f"\nПомилка: {e}")


if __name__ == "__main__":
    main()
