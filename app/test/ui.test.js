/**
 * Наскрізна перевірка інтерфейсу: піднімає справжнє вікно додатка, під'єднується
 * до нього по DevTools-протоколу і робить те саме, що робив би користувач —
 * друкує запит, тисне «Пошук», перемикає вкладки, відкриває альбом.
 *
 *   npm run test:ui
 *
 * Змінна MG_SHOTS=<тека> вмикає знімки вікна: частину помилок (розтягнута
 * мітка, мертва смужка) видно тільки оком, перевіркою DOM їх не спіймати.
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const PORT = 9333;
const APP = path.join(__dirname, "..");
const ELECTRON = path.join(APP, "node_modules", "electron", "dist", "electron.exe");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "OK  " : "ПРОВАЛ"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* вікно ще не піднялося */
    }
    await sleep(500);
  }
  throw new Error("Вікно додатка не з'явилося");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) return listeners.forEach((fn) => fn(msg));
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const myId = ++id;
          ws.send(JSON.stringify({ id: myId, method, params }));
          return new Promise((res, rej) => pending.set(myId, { resolve: res, reject: rej }));
        },
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      }),
    );
  });
}

(async () => {
  const child = spawn(ELECTRON, [APP, `--remote-debugging-port=${PORT}`], {
    cwd: APP,
    env: { ...process.env, MG_DEBUG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("  [main] " + d));
  child.stderr.on("data", (d) => {
    const s = String(d);
    if (/Error|error/.test(s)) process.stdout.write("  [main/err] " + s);
  });

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const errors = [];
  // Будь-яка помилка в інтерфейсі має провалити тест, а не лишитись непоміченою.
  // Сюди ж потрапляють порушення CSP: вони не кидають винятку, тож інакше
  // мертва смужка прогресу так і лишилась би «успішним» тестом.
  await cdp.send("Log.enable").catch(() => {});
  cdp.on((msg) => {
    if (msg.method !== "Log.entryAdded") return;
    const e = msg.params.entry;
    if (e.level === "error") errors.push(`${e.source}: ${e.text}`.slice(0, 160));
  });
  const evalJs = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      errors.push(r.exceptionDetails.exception?.description || "виняток");
      return null;
    }
    return r.result.value;
  };

  const SHOTS = process.env.MG_SHOTS;
  let shotNo = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
    require("fs").writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("  знімок: " + file);
  };

  try {
    await cdp.send("Page.enable").catch(() => {});
    console.log("\n[1] Вікно завантажилось");
    check("заголовок", (await evalJs("return document.title")) === "Music Grabber");
    // Фон body заданий градієнтом, тобто background-IMAGE: перевіряти
    // backgroundColor тут безглуздо — він законно прозорий.
    check("стилі застосувались", (await evalJs(`
      const b = getComputedStyle(document.body);
      const tab = getComputedStyle(document.querySelector('.tab.active'));
      return document.styleSheets.length > 0
          && b.backgroundImage.includes('gradient')
          && tab.borderBottomColor === 'rgb(124, 92, 255)';`)) === true);
    check("місток api доступний", (await evalJs("return typeof window.api?.search")) === "function");
    check(
      "теку підставлено з налаштувань",
      Boolean(await evalJs("return document.querySelector('#folderName').textContent.trim()")),
      await evalJs("return document.querySelector('#folderBtn').title"),
    );
    check("попередження про бінарники не показано", (await evalJs("return document.querySelector('#warn').hidden")) === true);
    // Регресія: `display:flex` у нашій таблиці перебивав службове [hidden],
    // і панель вибору висіла на екрані з написом «0 вибрано».
    check("hidden справді ховає", (await evalJs(`
      const el = document.querySelector('#selbar');
      return el.hidden && getComputedStyle(el).display === 'none';`)) === true);

    console.log("\n[2] Пошук «Black Magick SS»");
    await evalJs(`
      document.querySelector('#q').value = 'Black Magick SS';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);

    let counts = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      counts = await evalJs(`
        if (document.querySelector('.spinner')) return null;
        return [...document.querySelectorAll('.tab .cnt')].map(e => Number(e.textContent));`);
      if (counts) break;
    }
    check("пошук завершився", Array.isArray(counts), counts ? `треки/альбоми/виконавці = ${counts}` : "не дочекались");
    check("знайдено треки", counts?.[0] > 0);
    check("знайдено альбоми", counts?.[1] > 0);
    check("знайдено виконавців", counts?.[2] > 0);
    check("намальовано рядки треків", (await evalJs("return document.querySelectorAll('.row').length")) > 0);
    // Регресія: правило `.row .name span` ловило мітку джерела і робило її
    // блоком на всю ширину колонки — рядок ставав утричі вищим.
    check("мітка джерела не розтягнута", (await evalJs(`
      const b = document.querySelector('.row .badge');
      const row = document.querySelector('.row .name');
      return getComputedStyle(b).display === 'inline-block'
          && b.getBoundingClientRect().width < row.getBoundingClientRect().width / 2;`)) === true);
    await shot("треки");
    check(
      "є мітки джерел",
      (await evalJs("return [...new Set([...document.querySelectorAll('.badge')].map(b=>b.className))].join()")).includes("badge"),
    );

    console.log("\n[3] Вибір треків");
    await evalJs("document.querySelectorAll('.row')[0].click(); return true");
    check("клік по рядку вибирає", (await evalJs("return document.querySelector('#selCount').textContent")) === "1 вибрано");
    check("панель вибору з'явилась", (await evalJs("return !document.querySelector('#selbar').hidden")) === true);
    await evalJs("document.querySelector('#selNone').click(); return true");
    check("«зняти вибір» працює", (await evalJs("return document.querySelector('#selbar').hidden")) === true);

    console.log("\n[4] Вкладка «Альбоми» і відкриття альбому");
    await evalJs("document.querySelector('.tab[data-tab=albums]').click(); return true");
    await sleep(300);
    const cards = await evalJs("return document.querySelectorAll('.card').length");
    check("картки альбомів намальовані", cards > 0, `${cards} шт.`);
    await shot("альбоми");

    await evalJs("document.querySelectorAll('.card')[0].click(); return true");
    let album = null;
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      album = await evalJs(`
        if (document.querySelector('.spinner')) return null;
        const h = document.querySelector('.detail-head h1');
        if (!h) return null;
        return { title: h.textContent,
                 tracks: document.querySelectorAll('.row').length,
                 canGrab: !document.querySelector('[data-act=dl-album]')?.disabled };`);
      if (album) break;
    }
    check("альбом відкрився", Boolean(album), album ? `«${album.title}»` : "не дочекались");
    check("треклист показано", album?.tracks > 0, `${album?.tracks} треків`);
    check("кнопка «Завантажити альбом» активна", album?.canGrab === true);
    await shot("альбом-деталі");

    console.log("\n[5] Навігація назад");
    await evalJs("document.querySelector('[data-act=back]').click(); return true");
    await sleep(300);
    check("повернулись до результатів", (await evalJs("return !document.querySelector('#tabs').hidden")) === true);

    console.log("\n[6] Вкладка «Виконавці»");
    await evalJs("document.querySelector('.tab[data-tab=artists]').click(); return true");
    await sleep(300);
    check("картки виконавців є", (await evalJs("return document.querySelectorAll('.card').length")) > 0);
    await shot("виконавці");

    console.log("\n[6b] Сторінка виконавця з YouTube Music");
    await evalJs(`
      const c = [...document.querySelectorAll('.card')].find(c => c.querySelector('.badge.ytmusic'));
      (c || document.querySelector('.card')).click(); return true;`);
    let art = null;
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      art = await evalJs(`
        if (document.querySelector('.spinner')) return null;
        const h = document.querySelector('.detail-head h1');
        if (!h) return null;
        return { name: h.textContent,
                 secs: [...document.querySelectorAll('h3.sec')].map(e=>e.textContent),
                 cards: document.querySelectorAll('.card').length,
                 rows: document.querySelectorAll('.row').length };`);
      if (art) break;
    }
    check("виконавець відкрився", Boolean(art), art ? `«${art.name}»` : "не дочекались");
    check("є розділи дискографії", art?.secs?.length > 0, (art?.secs || []).join(", "));
    await shot("виконавець");

    console.log("\n[6c] Зупинка пошуку");
    await evalJs(`
      document.querySelector('#q').value = 'metal';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await sleep(400);
    check("кнопка «Стоп» з'явилась", (await evalJs("return !document.querySelector('#stop').hidden")) === true);
    check("«Пошук» заблоковано", (await evalJs("return document.querySelector('#go').disabled")) === true);

    await evalJs("document.querySelector('#stop').click(); return true");
    check("«Стоп» сховалась одразу", (await evalJs("return document.querySelector('#stop').hidden")) === true);
    check("«Пошук» знову активний", (await evalJs("return document.querySelector('#go').disabled")) === false);
    check("сказано, що зупинено", (await evalJs("return document.querySelector('#main').textContent")).includes("зупинено"));

    // Найважливіше: зупинений пошук не має «дострілювати» результатом пізніше
    // і затирати те, що користувач уже бачить.
    await sleep(9000);
    check("зупинений пошук не домалював результати",
      (await evalJs("return document.querySelector('#main').textContent")).includes("зупинено"));
    check("після зупинки можна шукати знову", (await evalJs(`
      document.querySelector('#q').value = 'Kevin MacLeod';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return !!state.searchId;`)) === true);
    await evalJs("document.querySelector('#stop').click(); return true");

    console.log("\n[7] Справжнє завантаження через чергу");
    const fs = require("fs");
    const os = require("os");
    const OUT = path.join(os.tmpdir(), "mg-ui-test");
    fs.rmSync(OUT, { recursive: true, force: true });

    // Через поле пошуку — щоб перевірити і гілку «вставлене посилання».
    await evalJs(`
      state.settings.outDir = ${JSON.stringify(OUT)};
      document.querySelector('#q').value = 'https://www.youtube.com/watch?v=N0KuBFK9r24';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);

    let byUrl = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      byUrl = await evalJs(`
        if (document.querySelector('.spinner')) return null;
        const r = document.querySelectorAll('.row');
        return r.length ? { n: r.length, first: r[0].querySelector('b').textContent } : null;`);
      if (byUrl) break;
    }
    check("посилання розкрилось у трек", Boolean(byUrl), byUrl ? `${byUrl.n}: ${byUrl.first}` : "не дочекались");

    // Опитувати смужку раз на секунду недостатньо: трек качається за 2-3 с,
    // і проміжні значення просто не потрапляють у вибірку. Тому записуємо
    // кожне оновлення, яке реально доходить до інтерфейсу.
    await evalJs(`
      window.__seen = [];
      const real = state.jobs.set.bind(state.jobs);
      state.jobs.set = (k, v) => { window.__seen.push(v.percent); return real(k, v); };
      return true;`);

    await evalJs(`document.querySelector('.row [data-act=dl-one]').click(); return true`);
    check("черга розгорнулась", (await evalJs("return !document.querySelector('#queue').classList.contains('collapsed')")) === true);

    let job = null;
    for (let i = 0; i < 180; i++) {
      await sleep(500);
      const cur = await evalJs(`
        const j = [...state.jobs.values()].pop();
        if (!j) return null;
        const bar = document.querySelector('.job .bar > i');
        return { status: j.status, percent: j.percent, files: j.files, error: j.error,
                 barWidth: bar ? bar.style.width : null,
                 note: document.querySelector('.job .jn small')?.textContent };`);
      if (cur && (cur.status === "done" || cur.status === "error")) { job = cur; break; }
      if (i === 6) await shot("черга-в-роботі");
    }

    const seen = (await evalJs("return window.__seen")) || [];
    check("завдання завершилось", Boolean(job), job ? `${job.status} — ${job.note}` : "не дочекались");
    check("статус «готово»", job?.status === "done", job?.error || "");
    check(
      "інтерфейс отримував проміжний прогрес",
      seen.some((p) => p > 0 && p < 100),
      `${seen.length} оновлень: ${seen.map((p) => Math.round(p)).join(",").slice(0, 70)}`,
    );
    check("смужка доїхала до 100%", job?.barWidth === "100%", job?.barWidth || "");

    const onDisk = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
    check("файл справді на диску", onDisk.length === 1, JSON.stringify(onDisk));
    check("це mp3 з іменем «Автор - Назва»", /^[^-]+ - .+\.mp3$/.test(onDisk[0] || ""), onDisk[0] || "");
    await shot("черга-готово");

    console.log("\n[8] Помилки в консолі інтерфейсу");
    check("без винятків і порушень CSP", errors.length === 0, [...new Set(errors)].slice(0, 2).join(" | "));
  } catch (e) {
    console.log("  ПРОВАЛ (виняток тесту): " + e.message);
    failures++;
  } finally {
    cdp.close();
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  }

  console.log(failures ? `\nПРОВАЛІВ: ${failures}` : "\nІнтерфейс працює.");
  setTimeout(() => process.exit(failures ? 1 : 0), 800);
})();
