"use strict";
/**
 * Малює icon.ico для інсталятора й самої програми.
 *
 *   npm run icon
 *
 * Без нього electron-builder ставить типову іконку Electron — ту саму
 * молекулу, яку носить кожен другий застосунок, і наш знак лишається жити
 * лише всередині вікна.
 *
 * Растеризує сам Electron: у ньому вже є все, що треба, а тягнути заради
 * однієї картинки окремий рендерер SVG — зайве. Скрипт запускається двічі:
 * спершу звичайним Node (той лише піднімає Electron), потім усередині
 * Electron — саме там і робиться робота.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const OUT = path.join(__dirname, "..", "build-assets", "icon.ico");

/**
 * Знак валькнута. Джерело правди — ICONS.valknut у renderer/app.js; якщо
 * міняєш його там, перемалюй іконку заново («npm run icon»).
 */
const PATHS = [
  "M12 5.05 6.11 15.25h11.78z",
  "M9.88 8.73 3.99 18.93h11.78z",
  "M14.12 8.73 8.23 18.93h11.78z",
];

/** Розміри, які Windows справді бере: панель задач, робочий стіл, Провідник. */
const SIZES = [256, 128, 64, 48, 32, 16];

/**
 * Товщина лінії залежить від розміру.
 *
 * Обводка масштабується разом із viewBox, тож на 16 пікселях трикутники
 * зливаються в сіру пляму. Дрібним розмірам даємо помітно товщу лінію —
 * знак читається гірше «за креслеником», зате взагалі читається.
 */
function strokeFor(size) {
  if (size <= 16) return 2.6;
  if (size <= 32) return 2.1;
  if (size <= 48) return 1.8;
  return 1.5;
}

function svg(size) {
  const d = PATHS.map((p) => `<path d="${p}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="#ffffff" stroke-width="${strokeFor(size)}" stroke-linejoin="miter">${d}</svg>`
  );
}

/** Збирає ICO з готових PNG. Формат простий: заголовок, каталог, самі картинки. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // зарезервовано
  header.writeUInt16LE(1, 2); // 1 — саме іконка, а не курсор
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;

  images.forEach((im, i) => {
    const at = i * 16;
    // 256 записується нулем: на розмір відведено один байт.
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, at);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, at + 1);
    dir.writeUInt8(0, at + 2); // палітри немає
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4); // площин
    dir.writeUInt16LE(32, at + 6); // біт на піксель
    dir.writeUInt32LE(im.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += im.png.length;
  });

  return Buffer.concat([header, dir, ...images.map((im) => im.png)]);
}

// ------------------------------------------------------------------ усередині Electron

async function render() {
  const os = require("os");
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();

  // Вікно одне на всі розміри: створювати й нищити його по колу Electron не
  // любить — друге ж завантаження падає з ERR_FAILED. Сторінки кладемо в
  // тимчасові файли, бо data:-адреси тут теж підводять.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-icon-"));
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    // Позаекранний рендеринг: знімок прихованого вікна у Windows часто
    // виходить порожнім, а тут картинка збирається без екрана взагалі.
    webPreferences: { offscreen: true },
  });

  const images = [];
  try {
    for (const size of SIZES) {
      // Малюємо кожен розмір окремо, а не зменшуємо один великий: інакше
      // товщина лінії для дрібних не спрацювала б.
      const file = path.join(tmp, `${size}.html`);
      fs.writeFileSync(
        file,
        `<body style="margin:0;background:transparent;display:grid;place-items:center;` +
          `width:${size}px;height:${size}px">${svg(size)}</body>`,
        "utf8",
      );

      win.setContentSize(size, size);
      await win.loadFile(file);
      // Позаекранному вікну треба дати намалювати кадр, інакше знімок
      // застає попередній розмір.
      await new Promise((r) => setTimeout(r, 120));

      const shot = await win.webContents.capturePage();
      const png = shot.resize({ width: size, height: size, quality: "best" }).toPNG();
      if (!png.length) throw new Error(`порожній знімок для ${size}px`);
      images.push({ size, png });
      console.log(`  ${size}×${size} — ${(png.length / 1024).toFixed(1)} КБ`);
    }
  } finally {
    win.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buildIco(images));
  console.log(`\nГотово: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} КБ)`);

  // Знімок найбільшого розміру окремо — щоб було на що подивитись оком.
  const preview = process.env.MG_ICON_PREVIEW;
  if (preview) fs.writeFileSync(preview, images[0].png);

  app.quit();
}

// ------------------------------------------------------------------ звичайний Node

function relaunchInElectron() {
  const electron = require("electron");
  if (typeof electron !== "string") throw new Error("не знайдено виконуваний файл Electron");
  console.log("Малюю іконку…");
  const child = spawn(electron, [__filename], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  child.on("close", (code) => process.exit(code || 0));
}

if (process.versions.electron) {
  render().catch((e) => {
    console.error("Не вдалося: " + e.message);
    process.exit(1);
  });
} else {
  relaunchInElectron();
}
