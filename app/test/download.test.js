/**
 * Перевірка того, що реально лягає на диск: прапорці yt-dlp, розбір прогресу,
 * ім'я файлу, тег artist і вшита обкладинка.
 *
 *   npm run test:download
 */
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const binaries = require("../src/main/binaries");
const { buildArgs, parseLine, TRANSIENT, TEMP_ROOT } = require("../src/main/download");

const URL = "https://www.youtube.com/watch?v=N0KuBFK9r24"; // Kevin MacLeod, CC-BY
const OUT = path.join(os.tmpdir(), "mg-test");
const JOB_TMP = path.join(TEMP_ROOT, "test-job");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "ПРОВАЛ"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// --- 1. розбір рядків прогресу (без мережі) ---
console.log("\n[1] Розбір виводу yt-dlp");
{
  const job = { files: [], percent: 0 };
  parseLine(job, "@P@524288@1048576@250000@4");
  check("відсоток", job.percent === 50, `отримано ${job.percent}`);
  check("швидкість", job.speed === 250000);

  parseLine(job, "@F@C:\\музика\\Автор - Пісня.mp3");
  check("шлях до файлу", job.files[0] === "C:\\музика\\Автор - Пісня.mp3");

  parseLine(job, "[download] Downloading item 3 of 12");
  check("номер треку в альбомі", job.index === 3 && job.total === 12);

  parseLine(job, "[EmbedThumbnail] mp3 не підтримує…");
  check("фаза обробки", job.phase === "process");
}

// --- 1b. які помилки вважаємо тимчасовими ---
console.log("\n[1b] Розпізнавання тимчасових збоїв");
{
  const transient = [
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "ERROR: [youtube] abc: HTTP Error 429: Too Many Requests",
    "ERROR: Unable to download webpage: The read operation timed out",
    "ERROR: unable to download video data: HTTP Error 503: Service Unavailable",
    "ERROR: Connection reset by peer",
  ];
  const permanent = [
    "ERROR: [youtube] abc: Video unavailable",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "ERROR: Requested format is not available",
    "ERROR: Unsupported URL: https://example.com/x",
    "ERROR: [youtube] abc: This video is age-restricted",
  ];
  for (const m of transient) check("тимчасова: " + m.slice(7, 46), TRANSIENT.test(m));
  for (const m of permanent) check("постійна: " + m.slice(7, 46), !TRANSIENT.test(m));
}

// --- 1c. окрема тека для альбому та вибір формату ---
console.log("\n[1c] Складання аргументів yt-dlp");
{
  const base = { url: "u", outDir: "D:\\out", tempDir: "D:\\tmp", format: "m4a" };
  const tmpl = (job) => {
    const a = buildArgs(job);
    return a[a.indexOf("-o") + 1];
  };

  check("одиночний трек — без теки", tmpl({ ...base, isPlaylist: false, albumFolder: true })
    === "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");
  check("альбом — у власну теку", tmpl({ ...base, isPlaylist: true, albumFolder: true })
    === "%(album,playlist_title,playlist,uploader)s/%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");
  check("вимкнена настройка поважається", tmpl({ ...base, isPlaylist: true, albumFolder: false })
    === "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");

  const has = (job, ...want) => {
    const a = buildArgs(job).join(" ");
    return want.every((w) => a.includes(w));
  };
  check("m4a просить саме m4a-потік", has({ ...base, format: "m4a" }, "bestaudio[ext=m4a]", "--audio-format m4a"));
  check("opus бере найкращий потік", has({ ...base, format: "opus" }, "-f bestaudio/best", "--audio-format opus"));
  check("mp3 задає 320K", has({ ...base, format: "mp3" }, "--audio-format mp3", "--audio-quality 320K"));
  // Один трек з YouTube може висіти в «радіо»-плейлисті на сотні відео.
  check("для одного треку стоїть --no-playlist", has({ ...base, isPlaylist: false }, "--no-playlist"));
  check("для альбому --no-playlist немає", !has({ ...base, isPlaylist: true }, "--no-playlist"));
}

// --- 2. бінарники ---
console.log("\n[2] Зовнішні програми");
const st = binaries.status();
check("yt-dlp", Boolean(st.ytdlp), st.ytdlp ? `${st.ytdlp.kind} ${st.ytdlp.version}` : "не знайдено");
check("ffmpeg", Boolean(st.ffmpeg), st.ffmpeg || "не знайдено");
if (!st.ok) {
  console.log("\nБез бінарників далі перевіряти нічого.");
  process.exit(1);
}

// --- 3. справжнє завантаження ---
console.log("\n[3] Справжнє завантаження в " + OUT);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.rmSync(JOB_TMP, { recursive: true, force: true });
fs.mkdirSync(JOB_TMP, { recursive: true });

const job = {
  url: URL,
  outDir: OUT,
  tempDir: JOB_TMP,
  format: "mp3",
  isPlaylist: false,
  files: [],
  percent: 0,
};
const bin = binaries.ytdlp();
const args = buildArgs(job);
console.log("  аргументи: " + args.map((a) => (a === "" ? '""' : a)).join(" ").slice(0, 220) + " …");

const child = spawn(bin.file, [...bin.prefix, ...args], {
  windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});

let progressSeen = 0;
let buf = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop();
  for (const l of lines) {
    if (l.startsWith("@P@")) progressSeen++;
    if (l.trim()) parseLine(job, l.trim());
  }
});
child.stderr.on("data", (d) => (stderr += d));

child.on("close", (code) => {
  console.log(`  код виходу: ${code}`);
  if (stderr.trim()) console.log("  stderr: " + stderr.trim().split("\n").slice(-3).join(" | "));

  check("оновлення прогресу приходили", progressSeen > 0, `${progressSeen} шт.`);
  check("yt-dlp повідомив шлях (@F@)", job.files.length === 1, job.files.join(", "));

  const files = fs.readdirSync(OUT);
  const leftInTemp = fs.existsSync(JOB_TMP) ? fs.readdirSync(JOB_TMP) : [];
  console.log("  у теці: " + JSON.stringify(files));
  check("рівно один файл (обкладинка не лишилась окремо)", files.length === 1);
  // Уся проміжна робота має відбуватись у своїй теці: саме тому невдале
  // завантаження більше не лишає в музиці .jpg без музики.
  check("проміжні файли не в теці музики", !files.some((f) => /\.(jpg|webp|part|ytdl|m4a)$/i.test(f)));
  check("тимчасова тека спорожніла", leftInTemp.length === 0, JSON.stringify(leftInTemp));
  check("розширення .mp3", files[0]?.endsWith(".mp3"));
  check("ім'я «Автор - Назва»", /^[^-]+ - .+\.mp3$/.test(files[0] || ""), files[0]);

  // --- 4. що всередині файлу ---
  console.log("\n[4] Вміст файлу");
  const ff = path.join(binaries.ffmpegDir(), "ffmpeg" + (process.platform === "win32" ? ".exe" : ""));
  let probe = "";
  try {
    execFileSync(ff, ["-hide_banner", "-i", path.join(OUT, files[0])], { encoding: "utf8" });
  } catch (e) {
    probe = (e.stderr || "") + (e.stdout || ""); // ffmpeg без -o завжди «падає», але пише інфо
  }
  const artist = (probe.match(/^\s*artist\s*:\s*(.+)$/im) || [])[1]?.trim();
  const title = (probe.match(/^\s*title\s*:\s*(.+)$/im) || [])[1]?.trim();

  check("обкладинка вшита (mjpeg відеопотік)", /Video:\s*mjpeg/i.test(probe));
  check("тег title є", Boolean(title), title || "нема");
  check("тег artist є", Boolean(artist), artist || "нема");
  check("у тегу artist один виконавець (без ком)", !artist || !artist.includes(","), artist || "");

  console.log(failures ? `\nПРОВАЛІВ: ${failures}` : "\nУсе гаразд.");
  process.exit(failures ? 1 : 0);
});
