/**
 * Наскрізна перевірка інтерфейсу: піднімає справжнє вікно додатка, під'єднується
 * до нього по DevTools-протоколу і робить те саме, що робив би користувач.
 *
 *   npm run test:ui
 *
 * Змінна MG_SHOTS=<тека> вмикає знімки вікна: частину помилок (розтягнута
 * мітка, мертва смужка прогресу) видно тільки оком, перевіркою DOM їх не спіймати.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 9333;
const APP = path.join(__dirname, "..");
const ELECTRON = path.join(APP, "node_modules", "electron", "dist", "electron.exe");
const OUT = path.join(os.tmpdir(), "mg-ui-test");

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
  fs.rmSync(OUT, { recursive: true, force: true });

  const child = spawn(ELECTRON, [APP, `--remote-debugging-port=${PORT}`], {
    cwd: APP,
    env: { ...process.env, MG_DEBUG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("  [main] " + d));

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Log.enable").catch(() => {});

  const errors = [];
  // Сюди потрапляють і порушення CSP: вони не кидають винятку, тож інакше
  // мертва смужка прогресу так і лишилась би «успішним» тестом.
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
    fs.writeFileSync(path.join(SHOTS, `${String(++shotNo).padStart(2, "0")}-${name}.png`), Buffer.from(r.data, "base64"));
  };

  /** Чекає, доки вираз поверне щось не-null. */
  const until = async (expr, tries = 40, ms = 700) => {
    for (let i = 0; i < tries; i++) {
      await sleep(ms);
      const v = await evalJs(expr);
      if (v) return v;
    }
    return null;
  };

  try {
    console.log("\n[1] Вікно і каркас");
    check("заголовок", (await evalJs("return document.title")) === "Music Grabber");
    check("стилі застосувались", (await evalJs(`
      const b = getComputedStyle(document.body);
      const tab = getComputedStyle(document.querySelector('.tab.active'));
      return document.styleSheets.length > 0
          && b.backgroundImage.includes('gradient')
          && tab.borderBottomColor === 'rgb(124, 92, 255)';`)) === true);
    check("місток api доступний", (await evalJs("return typeof window.api?.search")) === "function");
    check("ліва панель має 4 розділи", (await evalJs("return document.querySelectorAll('.navbtn').length")) === 4);
    check("плеєр на місці й неактивний", (await evalJs(`
      return document.querySelector('#player').classList.contains('idle')
          && document.querySelector('#plPlay').disabled;`)) === true);
    // Регресія: `display:flex` у нашій таблиці перебивав службове [hidden],
    // і панель вибору висіла на екрані з написом «0 вибрано».
    check("hidden справді ховає", (await evalJs(`
      const el = document.querySelector('#selbar');
      return el.hidden && getComputedStyle(el).display === 'none';`)) === true);
    check("попередження про бінарники не показано", (await evalJs("return document.querySelector('#warn').hidden")) === true);
    check("множина українською", (await evalJs(`
      return [1,2,5,11,21,102].map(n => plural(n, TRACKS)).join('|');`))
      === "1 трек|2 треки|5 треків|11 треків|21 трек|102 треки");
    // Регресія: смужки еквалайзера мали height:auto до першого кадру анімації
    // (а затримка там до 0.45 с) — і замість еквалайзера була крапка.
    check("смужки еквалайзера мають висоту", (await evalJs(`
      const d = document.createElement('div');
      d.className = 'eq';
      d.innerHTML = '<i></i><i></i>';
      document.body.appendChild(d);
      const h = d.querySelector('i').getBoundingClientRect().height;
      d.remove();
      return h;`)) > 2);

    console.log("\n[2] Пошук «Black Magick SS»");
    await evalJs(`
      document.querySelector('#q').value = 'Black Magick SS';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    const counts = await until(`
      if (document.querySelector('.spinner')) return null;
      const c = [...document.querySelectorAll('.tab .cnt')].map(e => Number(e.textContent));
      return c.some(n => n > 0) ? c : null;`, 60, 1000);
    check("пошук завершився", Array.isArray(counts), counts ? `треки/альбоми/виконавці = ${counts}` : "не дочекались");
    check("знайдено треки", counts?.[0] > 0);
    check("знайдено альбоми", counts?.[1] > 0);
    check("знайдено виконавців", counts?.[2] > 0);
    // Регресія: правило `.row .name span` ловило мітку джерела і робило її
    // блоком на всю ширину колонки — рядок ставав утричі вищим.
    check("мітка джерела не розтягнута", (await evalJs(`
      const b = document.querySelector('.row .badge');
      const n = document.querySelector('.row .name');
      return getComputedStyle(b).display === 'inline-block'
          && b.getBoundingClientRect().width < n.getBoundingClientRect().width / 2;`)) === true);
    await shot("треки");

    console.log("\n[3] Вибір треків");
    await evalJs("document.querySelectorAll('.row')[0].click(); return true");
    check("клік по рядку вибирає", (await evalJs("return document.querySelector('#selCount').textContent")) === "1 вибрано");
    check("панель вибору з'явилась", (await evalJs("return !document.querySelector('#selbar').hidden")) === true);
    await evalJs("document.querySelector('#selNone').click(); return true");
    check("«зняти вибір» працює", (await evalJs("return document.querySelector('#selbar').hidden")) === true);

    console.log("\n[4] Альбоми");
    await evalJs("document.querySelector('.tab[data-tab=albums]').click(); return true");
    await sleep(300);
    check("картки альбомів намальовані", (await evalJs("return document.querySelectorAll('.card').length")) > 0);
    await shot("альбоми");

    await evalJs("document.querySelectorAll('.card')[0].click(); return true");
    const album = await until(`
      if (document.querySelector('.spinner')) return null;
      const h = document.querySelector('.detail-head h1');
      if (!h) return null;
      return { title: h.textContent, tracks: document.querySelectorAll('.row').length,
               canGrab: !document.querySelector('[data-act=dl-album]')?.disabled };`, 30);
    check("альбом відкрився", Boolean(album), album ? `«${album.title}»` : "не дочекались");
    check("треклист показано", album?.tracks > 0, `${album?.tracks} треків`);
    check("кнопка альбому активна", album?.canGrab === true);
    await shot("альбом");

    console.log("\n[5] Виконавці");
    await evalJs("document.querySelector('[data-act=back]').click(); return true");
    await sleep(300);
    await evalJs("document.querySelector('.tab[data-tab=artists]').click(); return true");
    await sleep(300);
    await evalJs(`
      const c = [...document.querySelectorAll('.card')].find(c => c.querySelector('.badge.ytmusic'));
      (c || document.querySelector('.card')).click(); return true;`);
    const art = await until(`
      if (document.querySelector('.spinner')) return null;
      const h = document.querySelector('.detail-head h1');
      if (!h) return null;
      return { name: h.textContent, secs: [...document.querySelectorAll('h3.sec')].map(e=>e.textContent) };`, 30);
    check("виконавець відкрився", Boolean(art), art ? `«${art.name}»` : "не дочекались");
    check("є розділи дискографії", art?.secs?.length > 0, (art?.secs || []).join(", "));
    await shot("виконавець");

    console.log("\n[6] Зупинка пошуку");
    await evalJs(`
      document.querySelector('#q').value = 'metal';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await sleep(400);
    check("кнопка «Стоп» з'явилась", (await evalJs("return !document.querySelector('#stop').hidden")) === true);
    check("«Шукати» заблоковано", (await evalJs("return document.querySelector('#go').disabled")) === true);
    await evalJs("document.querySelector('#stop').click(); return true");
    check("«Стоп» сховалась одразу", (await evalJs("return document.querySelector('#stop').hidden")) === true);
    check("«Шукати» знову активний", (await evalJs("return document.querySelector('#go').disabled")) === false);
    // Найважливіше: зупинений пошук не має «дострілювати» результатом пізніше
    // і затирати те, що користувач уже бачить.
    await sleep(9000);
    check("зупинений пошук не домалював результати",
      (await evalJs("return document.querySelector('#main').textContent")).includes("зупинено"));

    console.log("\n[7] Міст зі Spotify");
    await evalJs(`
      document.querySelector('#q').value = 'https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    const br = await until(`
      if (document.querySelector('.spinner')) return null;
      const n = document.querySelector('.note.info');
      const r = document.querySelectorAll('.row');
      if (!n && !r.length) return null;
      return { note: n?.textContent || '', rows: r.length,
               first: r[0]?.querySelector('b')?.textContent || '' };`, 45);
    check("посилання Spotify оброблено", Boolean(br), br ? br.first : "не дочекались");
    check("знайдено відповідник на YouTube", br?.rows > 0, `${br?.rows} рядків`);
    check("чесно сказано про підміну джерела",
      /Spotify/.test(br?.note || "") && /YouTube Music/.test(br?.note || ""),
      (br?.note || "").slice(0, 90));
    await shot("міст-spotify");

    console.log("\n[8] Завантаження через чергу");
    await evalJs(`
      state.settings.outDir = ${JSON.stringify(OUT)};
      document.querySelector('#q').value = 'https://www.youtube.com/watch?v=N0KuBFK9r24';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    const byUrl = await until(`
      if (document.querySelector('.spinner')) return null;
      const r = document.querySelectorAll('.row');
      return r.length ? { n: r.length, first: r[0].querySelector('b').textContent } : null;`, 40, 1000);
    check("посилання розкрилось у трек", Boolean(byUrl), byUrl ? byUrl.first : "не дочекались");

    // Опитувати смужку раз на секунду недостатньо: трек качається за 2-3 с,
    // і проміжні значення просто не потрапляють у вибірку. Тому записуємо
    // кожне оновлення, яке реально доходить до інтерфейсу.
    await evalJs(`
      window.__seen = [];
      const real = state.jobs.set.bind(state.jobs);
      state.jobs.set = (k, v) => { window.__seen.push(v.percent); return real(k, v); };
      return true;`);

    await evalJs(`document.querySelector('.row [data-act=dl-one]').click(); return true`);
    check("з'явилась підказка про чергу", (await until(`
      const t = document.querySelector('#toast');
      return (!t.hidden && t.textContent.includes('чергу')) ? true : null;`, 8, 300)) === true);

    await evalJs(`document.querySelector('.navbtn[data-page=queue]').click(); return true`);
    check("сторінка черги показує завдання", (await evalJs("return document.querySelectorAll('.job').length")) > 0);
    check("бейдж черги видно", (await evalJs("return !document.querySelector('#navQueue').hidden")) === true);
    await sleep(1500);
    await shot("черга");

    const job = await until(`
      const j = [...state.jobs.values()].pop();
      if (!j || (j.status !== 'done' && j.status !== 'error')) return null;
      const bar = document.querySelector('.job .bar > i');
      return { status: j.status, files: j.files, error: j.error, barWidth: bar ? bar.style.width : null };`, 180, 500);
    const seen = (await evalJs("return window.__seen")) || [];
    check("завдання завершилось", Boolean(job), job ? job.status : "не дочекались");
    check("статус «готово»", job?.status === "done", job?.error || "");
    check("інтерфейс отримував проміжний прогрес", seen.some((p) => p > 0 && p < 100),
      `${seen.length} оновлень`);
    check("смужка доїхала до 100%", job?.barWidth === "100%", job?.barWidth || "");

    const onDisk = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
    check("файл справді на диску", onDisk.length === 1, JSON.stringify(onDisk));
    check("формат за замовчуванням — m4a без перекодування", /\.m4a$/.test(onDisk[0] || ""), onDisk[0] || "");
    check("ім'я «Автор - Назва»", /^[^-]+ - .+\.\w+$/.test(onDisk[0] || ""), onDisk[0] || "");

    console.log("\n[9] Сховище");
    await evalJs(`document.querySelector('.navbtn[data-page=library]').click(); return true`);
    const lib = await until(`
      if (document.querySelector('.spinner')) return null;
      const r = document.querySelectorAll('.row[data-path]');
      if (!r.length) return null;
      return { n: r.length, title: r[0].querySelector('b').textContent,
               artist: r[0].querySelector('.sub').textContent };`, 40);
    check("сховище знайшло завантажене", Boolean(lib), lib ? `${lib.n}: ${lib.artist} — ${lib.title}` : "не дочекались");
    check("теги прочитані з файлу", lib?.artist === "Kevin MacLeod", lib?.artist || "");
    await sleep(900); // дати обкладинці підвантажитись
    check("обкладинка витягнута з файлу", (await evalJs(`
      const im = document.querySelector('.row[data-path] .art');
      return im && im.src.startsWith('data:image') && im.src.length > 2000;`)) === true);
    await shot("сховище");

    console.log("\n[10] Плеєр");
    await evalJs(`document.querySelector('.row[data-path] [data-lact=play]').click(); return true`);
    const played = await until(`
      const a = document.querySelector('#audio');
      return (!a.paused && a.currentTime > 0.15) ? { t: a.currentTime, d: a.duration } : null;`, 20, 400);
    check("файл справді грає", Boolean(played), played ? `${played.t.toFixed(1)}с з ${Math.round(played.d)}с` : "не заграв");
    check("плеєр показує назву", (await evalJs("return document.querySelector('#plTitle').textContent")) === "Cipher");
    check("плеєр більше не «idle»", (await evalJs("return !document.querySelector('#player').classList.contains('idle')")) === true);
    await shot("плеєр");
    await evalJs(`document.querySelector('#plPlay').click(); return true`);
    await sleep(300);
    check("пауза працює", (await evalJs("return document.querySelector('#audio').paused")) === true);

    console.log("\n[11] Позначка «вже є» в пошуку");
    await evalJs(`
      document.querySelector('.navbtn[data-page=search]').click();
      document.querySelector('#q').value = 'Kevin MacLeod Cipher';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    const owned = await until(`
      if (document.querySelector('.spinner')) return null;
      const r = document.querySelectorAll('.row');
      if (!r.length) return null;
      return { any: !!document.querySelector('.badge.owned'), rows: r.length };`, 40, 1000);
    check("знайдений трек позначено як наявний", owned?.any === true, `${owned?.rows} рядків`);

    console.log("\n[12] Налаштування");
    await evalJs(`document.querySelector('.navbtn[data-page=settings]').click(); return true`);
    await sleep(600);
    check("сторінка намальована", (await evalJs("return document.querySelectorAll('.set').length")) >= 5);
    check("вибір формату є, FLAC немає", (await evalJs(`
      const o = [...document.querySelectorAll('#format option')].map(o => o.value);
      return o.join(',') === 'm4a,mp3';`)) === true);
    check("написано про DRM у Spotify",
      (await evalJs("return document.querySelector('#main').textContent")).includes("DRM"));
    check("написано про авторські права",
      (await evalJs("return document.querySelector('#main').textContent")).includes("авторськ"));
    check("показано знайдені бінарники", (await until(`
      const t = document.querySelector('#binSet')?.textContent || '';
      return t.includes('yt-dlp') && t.includes('ffmpeg') ? true : null;`, 10, 300)) === true);
    await shot("налаштування");

    console.log("\n[13] Помилки в консолі інтерфейсу");
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
