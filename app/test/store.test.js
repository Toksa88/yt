/**
 * Файли користувача: атомний запис і чесна поведінка з нечитним файлом.
 *
 *   npm run test:store
 *
 * Ані мережі, ані вікна — цей набір має відпрацьовувати за мить і не брехати
 * ніколи. Саме тут перевіряється те, чого не побачиш оком: що плейлисти не
 * зникають, коли запис урвався на середині.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/main/store");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "ПРОВАЛ"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mg-store-"));
const at = (name) => path.join(DIR, name);

console.log("\n[1] Звичайний обіг");
{
  const file = at("plain.json");
  const data = { favorites: [{ title: "Cipher" }], history: [] };

  check("запис вдався", store.writeJson(file, data) === true);
  const back = store.readJson(file, { fallback: null });
  check("прочиталось те саме", JSON.stringify(back) === JSON.stringify(data));
  // Тимчасовий файл існує лише під час запису; лишитись він не має.
  check("тимчасового файлу не лишилось", !fs.existsSync(file + ".tmp"));
}

console.log("\n[2] Файлу ще немає");
{
  const fallback = { favorites: [], history: [] };
  const got = store.readJson(at("nope.json"), { fallback });
  check("повертається типове значення", got === fallback);
  // Перший запуск — не подія. Скаржитись на нього не можна, інакше кожен
  // новий користувач одразу побачить повідомлення про втрату даних.
  check("і це не вважається поламкою", store.troubles().length === 0);
}

console.log("\n[3] Зіпсований файл");
{
  const file = at("broken.json");
  fs.writeFileSync(file, '{"favorites": [{"title": "Cip', "utf8"); // обрубок
  const got = store.readJson(file, { fallback: { favorites: [], history: [] } });

  check("почали з порожнього", Array.isArray(got.favorites) && got.favorites.length === 0);
  check("нечитний файл відкладено поруч", fs.existsSync(file + ".broken"));
  check("а з-під ніг прибрано", !fs.existsSync(file));
  check("уміст відкладеного цілий",
    fs.readFileSync(file + ".broken", "utf8").startsWith('{"favorites"'));

  const bad = store.troubles();
  check("про це повідомлено", bad.length === 1, bad.map((b) => b.name).join());
  check("названо саме той файл", bad[0]?.name === "broken.json");
}

console.log("\n[4] Правильний JSON із неправильним вмістом");
{
  const file = at("shape.json");
  // Колись плейлисти вміли отак перетворюватись на об'єкт після невдалої
  // зміни формату — для нас це таке саме псування, як і обрубок.
  fs.writeFileSync(file, '{"це": "не масив"}', "utf8");
  const got = store.readJson(file, { fallback: [], valid: Array.isArray });

  check("узято типове значення", Array.isArray(got) && got.length === 0);
  check("файл відкладено", fs.existsSync(file + ".broken"));
  check("додалась друга скарга", store.troubles().length === 2);
}

console.log("\n[5] Невдалий запис не чіпає того, що вже лежить");
{
  const file = at("survive.json");
  const good = [{ id: "p1", name: "Мій плейлист", tracks: [{ title: "Cipher" }] }];
  store.writeJson(file, good);

  // Кільцеве посилання — найпростіший спосіб зірвати запис на середині,
  // не ламаючи диска: JSON.stringify кидає виняток.
  const circular = { name: "погане" };
  circular.self = circular;
  check("запис чесно зізнався у невдачі", store.writeJson(file, circular) === false);

  const back = store.readJson(file, { fallback: [], valid: Array.isArray });
  check("старий плейлист на місці", JSON.stringify(back) === JSON.stringify(good));
  check("сміття після себе не лишило", !fs.existsSync(file + ".tmp"));
}

console.log("\n[6] Запис поверх наявного");
{
  const file = at("over.json");
  store.writeJson(file, [1, 2, 3]);
  store.writeJson(file, [4, 5]);
  const back = store.readJson(file, { fallback: [], valid: Array.isArray });
  check("лишилось нове, а не суміш", JSON.stringify(back) === "[4,5]", JSON.stringify(back));
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(failures ? `\nПРОВАЛІВ: ${failures}` : "\nФайли користувача в безпеці.");
process.exit(failures ? 1 : 0);
