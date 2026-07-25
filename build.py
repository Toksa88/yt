#!/usr/bin/env python3
"""
Збирає gui.py в один самодостатній exe з вшитим ffmpeg.

    py build.py

Результат: dist/YouTube Music Downloader.exe — його можна просто дати людині,
нічого ставити не треба (ані Python, ані ffmpeg).

Потрібно один раз:
    py -m pip install pyinstaller yt-dlp mutagen
    winget install Gyan.FFmpeg.Essentials
"""

import glob
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "YouTube Music Downloader"


def find_ffmpeg_exe():
    """Шукає ffmpeg.exe для вшивання. Essentials (~97 МБ) кращий за full (~231 МБ)."""
    found = []
    for pat in (
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials*\**\bin\ffmpeg.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\ffmpeg.exe"),
    ):
        found += glob.glob(pat, recursive=True)

    where = shutil.which("ffmpeg")
    if where:
        found.append(where)

    if not found:
        sys.exit("Не знайдено ffmpeg.exe. Виконай: winget install Gyan.FFmpeg.Essentials")

    # найменший — тобто essentials, а не full
    return min(found, key=os.path.getsize)


def check_mutagen():
    """Без mutagen exe зламається НА ЧУЖОМУ комп'ютері, а не тут.

    yt-dlp вшиває обкладинку в m4a або через mutagen, або через ffprobe.
    ffprobe ми навмисно не вшиваємо (це +96 МБ), а на машині розробника він
    зазвичай лежить поруч з ffmpeg — тож збірка виглядає робочою, і поломка
    вилазить лише в користувача. Тому падаємо тут і зараз.
    """
    try:
        import mutagen  # noqa: F401
    except ImportError:
        sys.exit("Немає mutagen — без нього m4a-обкладинки зламаються на чужому ПК.\n"
                 "Виконай: py -m pip install mutagen")


def main():
    check_mutagen()
    ffmpeg = find_ffmpeg_exe()
    print(f"ffmpeg: {ffmpeg} ({os.path.getsize(ffmpeg) / 1024 / 1024:.0f} МБ)")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",              # один файл, нічого розпаковувати
        "--windowed",             # без чорного вікна консолі
        "--name", NAME,
        # ffmpeg лягає в корінь _MEIPASS — саме там його шукає find_ffmpeg()
        "--add-binary", f"{ffmpeg}{os.pathsep}.",
        # tkinter тягне ці модулі динамічно, PyInstaller їх сам не завжди бачить
        "--hidden-import", "tkinter",
        "--hidden-import", "tkinter.filedialog",
        "--hidden-import", "tkinter.messagebox",
        # зайве всередині: ці пакети великі й нам не потрібні
        "--exclude-module", "numpy",
        "--exclude-module", "PIL",
        "--exclude-module", "pytest",
        os.path.join(HERE, "gui.py"),
    ]
    print("\n" + " ".join(cmd) + "\n")
    r = subprocess.run(cmd, cwd=HERE)
    if r.returncode:
        sys.exit(f"PyInstaller завершився з кодом {r.returncode}")

    exe = os.path.join(HERE, "dist", NAME + ".exe")
    if not os.path.isfile(exe):
        sys.exit("Збірка пройшла, але exe не знайдено — щось не так.")
    print(f"\nГотово: {exe}  ({os.path.getsize(exe) / 1024 / 1024:.0f} МБ)")


if __name__ == "__main__":
    main()
