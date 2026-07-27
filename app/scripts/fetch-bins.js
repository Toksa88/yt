"use strict";
/**
 * Кладе yt-dlp та ffmpeg у теку app/bin — звідти electron-builder вшиває їх
 * в інсталятор (див. extraResources у package.json), а binaries.js знаходить
 * їх першими й на машині розробника.
 *
 *   npm run bins          дістати те, чого ще немає
 *   npm run bins -- --force   перекачати наново
 *
 * Викликається автоматично перед складанням (prebuild), тому інсталятор
 * ніколи не виходить без бінарників: користувачеві не треба знати, що таке
 * yt-dlp, і тим паче шукати, де його качати.
 *
 * УВАГА про ліцензії: ffmpeg тут — GPL-збірка. Вона накладає зобов'язання на
 * того, хто поширює готовий інсталятор (див. розділ «Ліцензії» в README).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin");
const FORCE = process.argv.includes("--force");

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

/**
 * Збірка ffmpeg від самої команди yt-dlp. Саме її рекомендує yt-dlp: у ній є
 * латки для випадків, на яких офіційні збірки з ffmpeg.org спотикаються.
 */
const FFMPEG_URL =
  "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

const mb = (n) => (n / 1024 / 1024).toFixed(1) + " МБ";

async function download(url, dest) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** Розпаковує zip засобами системи: тягнути заради цього окрему залежність не варто. */
function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${into}" -Force`],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zip, "-d", into], { stdio: "inherit" });
  }
}

/** Шукає файл у розпакованому дереві: назва теки всередині архіву мінлива. */
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function have(name) {
  return !FORCE && fs.existsSync(path.join(BIN, name));
}

async function getYtdlp() {
  if (have("yt-dlp.exe")) {
    console.log("  yt-dlp.exe — уже є, пропускаю");
    return;
  }
  process.stdout.write("  yt-dlp.exe — качаю… ");
  const size = await download(YTDLP_URL, path.join(BIN, "yt-dlp.exe"));
  console.log(mb(size));
}

async function getFfmpeg() {
  if (have("ffmpeg.exe") && have("ffprobe.exe")) {
    console.log("  ffmpeg.exe, ffprobe.exe — уже є, пропускаю");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-ffmpeg-"));
  try {
    const zip = path.join(tmp, "ffmpeg.zip");
    process.stdout.write("  ffmpeg — качаю архів… ");
    console.log(mb(await download(FFMPEG_URL, zip)));

    console.log("  ffmpeg — розпаковую…");
    unzip(zip, tmp);

    // ffprobe теж потрібен: без нього yt-dlp не може перевірити, що саме
    // отримав, і частина постобробки тихо не спрацьовує.
    for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
      const src = findFile(tmp, name);
      if (!src) throw new Error(`в архіві немає ${name}`);
      fs.mkdirSync(BIN, { recursive: true });
      fs.copyFileSync(src, path.join(BIN, name));
      console.log(`  ${name} — ${mb(fs.statSync(src).size)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async function main() {
  console.log(`Бінарники → ${BIN}`);
  try {
    await getYtdlp();
    await getFfmpeg();
  } catch (e) {
    console.error(`\nНе вдалося: ${e.message}`);
    console.error("Поклади yt-dlp.exe та ffmpeg.exe у app/bin вручну або спробуй ще раз.");
    process.exit(1);
  }
  console.log("Готово.");
})();
