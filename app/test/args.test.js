/**
 * Аргументи yt-dlp і розбір його виводу.
 *
 *   npm run test:args
 *
 * Ані мережі, ані вікна. Раніше це жило на початку `download.test.js` — тобто
 * щоб перевірити одну регулярку, доводилось качати справжній трек із YouTube
 * і чекати хвилину. Тепер це окремо й миттєво, а живе завантаження лишилось
 * там, де йому й місце.
 *
 * Набір прапорців тут не косметика: кожен закриває конкретну поломку, яку
 * видно у файлі на диску. Пояснення — у шапці `download.js`.
 */
"use strict";

const { buildArgs, parseLine, TRANSIENT } = require("../src/main/download");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "ПРОВАЛ"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

console.log("\n[1] Розбір виводу yt-dlp");
{
  const job = { files: [], percent: 0 };

  parseLine(job, "@P@524288@1048576@250000@4");
  check("відсоток", job.percent === 50, `отримано ${job.percent}`);
  check("швидкість", job.speed === 250000);
  check("залишок часу", job.eta === 4);

  // yt-dlp зрідка віддає «NA» замість числа — Number дасть NaN, і смужка
  // показувала б «NaN Б/с».
  parseLine(job, "@P@1024@2048@NA@NA");
  check("«NA» не перетворюється на NaN", job.speed === 0 && job.eta === 0);
  check("а відсоток усе одно порахований", job.percent === 50);

  // Загального розміру може не бути взагалі — тоді відсоток чіпати не можна,
  // інакше смужка стрибне на нуль посеред завантаження.
  const before = job.percent;
  parseLine(job, "@P@1024@NA@100@1");
  check("без загального розміру відсоток не чіпається", job.percent === before);

  parseLine(job, "@F@C:\\музика\\Автор - Пісня.mp3");
  check("шлях до файлу", job.files[0] === "C:\\музика\\Автор - Пісня.mp3");
  check("файл порахований", job.done === 1);

  // Той самий файл двічі — yt-dlp таке робить при повторній обробці.
  parseLine(job, "@F@C:\\музика\\Автор - Пісня.mp3");
  check("дублікат не додається", job.files.length === 1, `${job.files.length}`);

  parseLine(job, "[download] Downloading item 3 of 12");
  check("номер треку в альбомі", job.index === 3 && job.total === 12);
  check("відсоток обнуляється на новому треку", job.percent === 0);

  parseLine(job, "[EmbedThumbnail] mp3 не підтримує…");
  check("фаза обробки", job.phase === "process");

  check("чужий рядок ігнорується", parseLine(job, "[youtube] abc: Downloading webpage") === false);
}

console.log("\n[2] Розпізнавання тимчасових збоїв");
{
  // Помилки, які минають самі: повторювати їх має сенс.
  const transient = [
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "ERROR: [youtube] abc: HTTP Error 429: Too Many Requests",
    "ERROR: Unable to download webpage: The read operation timed out",
    "ERROR: unable to download video data: HTTP Error 503: Service Unavailable",
    "ERROR: Connection reset by peer",
    "ERROR: Remote end closed connection without response",
  ];
  // А ці не зміняться, скільки не пробуй: повтор лише марнує час людини.
  const permanent = [
    "ERROR: [youtube] abc: Video unavailable",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "ERROR: Requested format is not available",
    "ERROR: Unsupported URL: https://example.com/x",
    "ERROR: [youtube] abc: This video is age-restricted",
    "ERROR: unable to open for writing: No space left on device",
  ];
  for (const m of transient) check("тимчасова: " + m.slice(7, 46), TRANSIENT.test(m));
  for (const m of permanent) check("постійна: " + m.slice(7, 46), !TRANSIENT.test(m));
}

console.log("\n[3] Складання аргументів yt-dlp");
{
  const base = { url: "u", outDir: "D:\\out", tempDir: "D:\\tmp", format: "m4a" };
  const args = (job) => buildArgs(job).join(" ");
  const tmpl = (job) => {
    const a = buildArgs(job);
    return a[a.indexOf("-o") + 1];
  };
  const has = (job, ...want) => want.every((w) => args(job).includes(w));

  check("одиночний трек — без теки", tmpl({ ...base, isPlaylist: false, albumFolder: true })
    === "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");
  check("альбом — у власну теку", tmpl({ ...base, isPlaylist: true, albumFolder: true })
    === "%(album,playlist_title,playlist,uploader)s/%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");
  check("вимкнена настройка поважається", tmpl({ ...base, isPlaylist: true, albumFolder: false })
    === "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s");

  check("m4a просить саме m4a-потік", has({ ...base, format: "m4a" }, "bestaudio[ext=m4a]", "--audio-format m4a"));
  check("opus бере найкращий потік", has({ ...base, format: "opus" }, "-f bestaudio/best", "--audio-format opus"));
  check("mp3 задає 320K", has({ ...base, format: "mp3" }, "--audio-format mp3", "--audio-quality 320K"));

  // Один трек з YouTube може висіти в «радіо»-плейлисті на сотні відео.
  check("для одного треку стоїть --no-playlist", has({ ...base, isPlaylist: false }, "--no-playlist"));
  check("для альбому --no-playlist немає", !has({ ...base, isPlaylist: true }, "--no-playlist"));

  // Кожен з цих прапорців колись закрив конкретну поломку — прибрати їх
  // випадково при правці сусіднього рядка легше, ніж здається.
  check("обкладинка переганяється в jpg", has(base, "--convert-thumbnails jpg"));
  check("обкладинка обрізається в квадрат", has(base, "crop=ih:ih"));
  check("зайві виконавці ріжуться з тега", has(base, "--replace-in-metadata artist"));
  check("теги вшиваються", has(base, "--embed-metadata", "--embed-thumbnail"));
  check("проміжні файли йдуть у свою теку", has(base, "-P temp:D:\\tmp"));
  check("готовий файл — у теку користувача", has(base, "-P home:D:\\out"));
  // --print неявно вмикає --quiet, а з ним глухне прогрес.
  check("прогрес не заглушений", has(base, "--no-quiet"));
  check("імена файлів придатні для Windows", has(base, "--windows-filenames"));

  check("невідомий формат не потрапляє в аргументи", !args({ ...base, format: "flac" }).includes("flac"));
}

console.log(failures ? `\nПРОВАЛІВ: ${failures}` : "\nАргументи й розбір виводу на місці.");
process.exit(failures ? 1 : 0);
