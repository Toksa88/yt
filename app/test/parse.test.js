/**
 * Розбір чужих даних: сторінки Spotify та Apple Music, тривалості, назви.
 *
 *   npm run test:parse
 *
 * Ані мережі, ані вікна. Це найкрихкіше місце програми — ми читаємо чужу
 * розмітку, якої ніхто не зобов'язувався тримати незмінною, — і водночас
 * єдине, що взагалі не було покрите.
 *
 * ЧОГО ЦЕЙ НАБІР НЕ ЛОВИТЬ: якщо Spotify завтра перейменує `__NEXT_DATA__`,
 * тут усе лишиться зеленим. Зразки нижче описують форму, на яку ми
 * розраховуємо, а не ту, яку справді віддає сервер. Зміну на їхньому боці
 * спіймає лише живий тест — цей стереже наш власний бік.
 */
"use strict";

const bridge = require("../src/main/bridge");
const search = require("../src/main/search");
const tags = require("../src/main/tags");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "ПРОВАЛ"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

/** Збирає сторінку плеєра Spotify тієї форми, яку ми розбираємо. */
const spotifyPage = (entity) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">` +
  JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) +
  `</script></body></html>`;

console.log("\n[1] Упізнавання посилань");
{
  check("трек Spotify", bridge.provider("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT") === "spotify");
  check("посилання з мовою в шляху",
    bridge.provider("https://open.spotify.com/intl-uk/album/1To7kv722A8SpZF789MZy7") === "spotify");
  check("Apple Music",
    bridge.provider("https://music.apple.com/us/album/nevermind/1440783617") === "applemusic");
  check("YouTube — не міст", bridge.provider("https://music.youtube.com/watch?v=N0KuBFK9r24") === null);
  check("не посилання взагалі", bridge.provider("Kevin MacLeod Cipher") === null);

  check("посилання відрізняється від запиту", search.looksLikeUrl("https://example.com/x") === true);
  check("запит із пробілами — не посилання", search.looksLikeUrl("http нема тут") === false);
}

console.log("\n[2] Один трек зі Spotify");
{
  const html = spotifyPage({
    name: "Smells Like Teen Spirit",
    artists: [{ name: "Nirvana" }, { name: "Хтось Ще" }],
    visualIdentity: { image: [{ url: "small.jpg" }, { url: "big.jpg" }] },
  });
  const r = bridge.parseSpotify(html, "track");

  check("назва", r.name === "Smells Like Teen Spirit");
  check("усі виконавці в підписі", r.artist === "Nirvana, Хтось Ще", r.artist);
  // Для пошуку в YouTube Music беремо лише першого: рядок із трьох імен
  // не знаходить нічого.
  check("для пошуку — лише перший", r.items[0].artist === "Nirvana", r.items[0].artist);
  check("обкладинка — найбільша з наявних", r.thumb === "big.jpg", r.thumb);
  check("один трек — один запис", r.items.length === 1);
}

console.log("\n[3] Альбом зі Spotify");
{
  const html = spotifyPage({
    name: "Nevermind",
    subtitle: "Nirvana",
    trackList: [
      { title: "Breed", subtitle: "Nirvana" },
      { title: "Lithium", subtitle: "Nirvana, Гість" },
    ],
  });
  const r = bridge.parseSpotify(html, "album");

  check("назва альбому", r.name === "Nevermind");
  check("усі треки на місці", r.items.length === 2, `${r.items.length}`);
  check("з підпису беремо першого виконавця", r.items[1].artist === "Nirvana", r.items[1].artist);
  check("обкладинки може не бути", r.thumb === null);
}

console.log("\n[4] Задовгий список Spotify");
{
  const many = Array.from({ length: bridge.MAX_ITEMS + 40 }, (_, i) => ({ title: `Трек ${i}`, subtitle: "Хтось" }));
  const r = bridge.parseSpotify(spotifyPage({ name: "Величезний", trackList: many }), "playlist");
  // Межа не косметична: кожен трек — це окремий пошук у YouTube Music.
  check("список обрізано до межі", r.items.length === bridge.MAX_ITEMS, `${r.items.length}`);
}

console.log("\n[5] Коли Spotify віддав не те");
{
  const nope = (html, kind, why) => {
    try {
      bridge.parseSpotify(html, kind);
      check(why, false, "виняток не кинуто");
    } catch (e) {
      check(why, /Spotify не віддав дані/.test(e.message), e.message);
    }
  };
  nope("<html><body>Порожньо</body></html>", "track", "сторінка без даних");
  nope(spotifyPage(null), "track", "дані є, а сутності немає");
}

console.log("\n[6] Apple Music");
{
  const page = (title, type, image) =>
    `<html><head>` +
    `<meta property="og:title" content="${title}" />` +
    `<meta content="${image}" property="og:image" />` +
    `<meta property="og:type" content="${type}" />` +
    `</head></html>`;

  const album = bridge.parseApple(page("Nevermind by Nirvana on Apple Music", "music.album", "cover.jpg"));
  check("назва без хвоста", album.name === "Nevermind", album.name);
  check("виконавець із заголовка", album.artist === "Nirvana", album.artist);
  check("це альбом", album.kind === "album");
  // Мітки трапляються в обох порядках: спершу content, спершу property.
  check("мітку прочитано в будь-якому порядку", album.thumb === "cover.jpg", album.thumb);

  const track = bridge.parseApple(page("Lithium by Nirvana on Apple Music", "music.song", ""));
  check("одинична пісня — не альбом", track.kind === "track");

  const plain = bridge.parseApple(page("Просто Назва on Apple Music", "music.song", ""));
  check("без «by» лишається сама назва", plain.name === "Просто Назва", plain.name);
  check("виконавець тоді порожній", plain.artist === "");

  const amp = bridge.parseApple(page("Sturm &amp; Drang by Хтось on Apple Music", "music.album", ""));
  check("розкодовано &amp;", amp.name === "Sturm & Drang", amp.name);
}

console.log("\n[7] Тривалість");
{
  check("«2:18» стає секундами", search.mmss("2:18") === 138, String(search.mmss("2:18")));
  check("година теж", search.mmss("1:02:03") === 3723, String(search.mmss("1:02:03")));
  check("число лишається числом", search.mmss(95) === 95);
  check("сміття дає null", search.mmss("хтозна") === null);
  check("порожнє дає null", search.mmss("") === null);
}

console.log("\n[8] Порівняння назв для моста");
{
  const same = (a, b) => search.normTitle(a) === search.normTitle(b);
  check("регістр не важить", same("Lithium", "LITHIUM"));
  check("«(feat. …)» відкидається", same("Song (feat. Someone)", "Song"));
  check("розділові знаки не важать", same("Rock'n'Roll — Live!", "rock n roll   live"));
  check("різні назви лишаються різними", !same("Breed", "Bleed"));
}

console.log("\n[9] Обкладинка з найбільшим розміром");
{
  const got = search.biggestThumb([
    { url: "https://x/img=w60-h60", width: 60 },
    { url: "https://x/img=w120-h120", width: 120 },
  ]);
  // YouTube кладе розмір у сам URL, тож більшу картинку можна просто попросити.
  check("береться найширша й просимо ще більшу", got === "https://x/img=w480-h480", got);
  check("порожній список — null", search.biggestThumb([]) === null);
  check("не масив — null", search.biggestThumb(undefined) === null);
}

console.log("\n[10] Імена файлів");
{
  check("заборонені для Windows знаки прибрано",
    tags.safeName('AC/DC: Back\\In "Black"?') === "ACDC BackIn Black", tags.safeName('AC/DC: Back\\In "Black"?'));
  // Windows не дає створити файл, що закінчується крапкою або пробілом.
  check("крапка в кінці зрізана", tags.safeName("Кінець...") === "Кінець");
  check("пробіли стиснуто", tags.safeName("  а   б  ") === "а б", `«${tags.safeName("  а   б  ")}»`);
  check("порожнє лишається порожнім", tags.safeName(null) === "");
}

console.log(failures ? `\nПРОВАЛІВ: ${failures}` : "\nРозбір чужих даних тримається.");
process.exit(failures ? 1 : 0);
