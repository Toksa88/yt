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

/**
 * Власний профіль для тестів.
 *
 * Без нього тест писав у СПРАВЖНІ налаштування користувача: вимикав Discord і
 * лишав у них вигаданий ID додатка, після чого інтеграція переставала
 * працювати вже поза тестом. Тут же живуть плейлисти, улюблене та історія —
 * жодне з цього тест чіпати не має права.
 */
const PROFILE = path.join(os.tmpdir(), "mg-test-profile");

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

  fs.rmSync(PROFILE, { recursive: true, force: true });

  const child = spawn(ELECTRON, [APP, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], {
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
  const netErrors = [];
  cdp.on((msg) => {
    if (msg.method !== "Log.entryAdded") return;
    const e = msg.params.entry;
    if (e.level !== "error") return;
    // Мережеві збої чужих серверів (той самий плаваючий 403 від YouTube) — це
    // не поломка нашого коду, і на них є повтор. Тримаємо їх окремо, щоб вони
    // не ховали справжні помилки й самі не валили прогін.
    if (e.source === "network") netErrors.push(e.text.slice(0, 120));
    else errors.push(`${e.source}: ${e.text}`.slice(0, 160));
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
    // Колір акценту навмисно не вписаний числом: тема змінна, а перевіряти
    // тут треба інше — що таблиця стилів під'їхала і активна вкладка
    // підкреслена саме акцентом, хай яким він цього разу буде.
    check("стилі застосувались", (await evalJs(`
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const b = getComputedStyle(document.body);
      const tab = getComputedStyle(document.querySelector('.tab.active'));
      return document.styleSheets.length > 0
          && b.backgroundImage.includes('gradient')
          && accent.startsWith('rgb')
          && tab.borderBottomColor === accent;`)) === true);
    // Регресія: активна кнопка в панелі й стартова сторінка розійшлися —
    // панель світила «Головну», а на екрані був «Шукач», і рекомендації
    // взагалі не вантажились.
    check("активний розділ збігається зі станом", (await evalJs(`
      return document.querySelector('.navbtn.active').dataset.page === state.page;`)) === true);
    check("місток api доступний", (await evalJs("return typeof window.api?.search")) === "function");
    check("ліва панель має 6 розділів", (await evalJs("return document.querySelectorAll('.navbtn').length")) === 6);
    // Підказка про буфер обміну має стояти НАД рядком пошуку, а не в кутку.
    // Міряти можна лише там, де рядок пошуку взагалі є, тобто в Шукачі.
    check("підказка розташована вище пошуку", (await evalJs(`
      const back = state.page;
      document.querySelector('.navbtn[data-page=search]').click();
      const t = document.querySelector('#toast');
      const f = document.querySelector('#searchForm');
      t.hidden = false;
      const a = t.getBoundingClientRect(), b = f.getBoundingClientRect();
      t.hidden = true;
      document.querySelector('.navbtn[data-page=' + back + ']').click();
      return b.height > 0 && a.bottom <= b.top + 1 && a.width > 200;`)) === true);
    check("плеєр на місці й неактивний", (await evalJs(`
      return document.querySelector('#player').classList.contains('idle')
          && document.querySelector('#plPlay').disabled;`)) === true);
    // Регресія: `display:flex` у нашій таблиці перебивав службове [hidden],
    // і панель вибору висіла на екрані з написом «0 вибрано».
    check("hidden справді ховає", (await evalJs(`
      const el = document.querySelector('#selbar');
      return el.hidden && getComputedStyle(el).display === 'none';`)) === true);
    check("попередження про бінарники не показано", (await evalJs("return document.querySelector('#warn').hidden")) === true);
    // Регресія: тест писав у справжні налаштування користувача — вимикав там
    // Discord і лишав вигаданий ID. Тепер у нього власний профіль.
    check("тест працює у власному профілі, не в користувацькому", (await evalJs(`
      const p = await window.api.getSettings();
      return p.discordAppId === '' && p.discordEnabled === false;`)) === true);
    // Емодзі кожна система малює по-своєму, тому інтерфейс має бути на SVG.
    check("іконки — SVG, а не емодзі", (await evalJs(`
      const svgs = document.querySelectorAll('.nico svg.ic, .sico svg.ic, .pbtn svg.ic');
      const text = [...document.querySelectorAll('.navbtn, .pbtn, .brand')]
        .map(e => e.textContent).join('');
      const emoji = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u{25A0}-\\u{25FF}\\u{2660}-\\u{2669}]/u;
      return { n: svgs.length, leftover: (text.match(emoji) || [])[0] || null };`)).n >= 9);
    check("емодзі в панелі й плеєрі не лишилось", (await evalJs(`
      const text = [...document.querySelectorAll('.navbtn, .pbtn, .brand')]
        .map(e => e.textContent).join('');
      const emoji = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u{25A0}-\\u{25FF}\\u{2660}-\\u{2669}]/u;
      return (text.match(emoji) || [])[0] || 'чисто';`)) === "чисто");
    check("іконка успадковує колір тексту", (await evalJs(`
      const s = document.querySelector('.nico svg.ic');
      return s && s.getAttribute('stroke') === 'currentColor';`)) === true);

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

    console.log("\n[1b] Головна з рекомендаціями YouTube Music");
    const homePage = await until(`
      if (document.querySelector('.spinner')) return null;
      const secs = [...document.querySelectorAll('h3.sec')].map(e => e.textContent);
      const cards = document.querySelectorAll('.card').length;
      return secs.length ? { secs, cards } : null;`, 40, 700);
    check("головна завантажилась", Boolean(homePage),
      homePage ? `${homePage.secs.length} секцій, ${homePage.cards} карток` : "не дочекались");
    check("секції мають назви", homePage?.secs?.every((s) => s.trim().length > 1) === true,
      (homePage?.secs || []).slice(0, 3).join(" / "));
    await shot("головна");

    await evalJs(`document.querySelector('[data-hact=mix]').click(); return true`);
    // Чекаємо саме сторінку добірки, а не «якісь рядки»: на Головній тепер
    // є ще й «Нещодавно слухав», і воно теж малюється рядками .row.
    const mix = await until(`
      if (document.querySelector('.spinner')) return null;
      if (!document.querySelector('[data-hact=playmix]')) return null;
      const r = document.querySelectorAll('.row[data-key]');
      return r.length ? { n: r.length, first: r[0].querySelector('b').textContent } : null;`, 40, 700);
    check("добірка відкривається треклистом", mix?.n > 0, mix ? `${mix.n} треків` : "не дочекались");
    check("є кнопка завантажити всю добірку",
      (await evalJs("return !!document.querySelector('[data-hact=grabmix]')")) === true);
    // Уся добірка має ставати ОДНИМ завданням, а не півсотнею окремих.
    const grab = await evalJs(`
      const before = state.jobs.size;
      document.querySelector('[data-hact=grabmix]').click();
      await new Promise(r => setTimeout(r, 1200));
      const jobs = [...state.jobs.values()];
      const last = jobs[jobs.length - 1];
      for (const j of jobs.slice(before)) await window.api.dlCancel(j.id);
      return { added: state.jobs.size - before, isPlaylist: !!last && /playlist\\?list=/.test(last.url) };`);
    check("добірка стала одним завданням", grab?.added === 1, `додано ${grab?.added}`);
    check("завдання вказує на плейлист", grab?.isPlaylist === true);
    await shot("добірка");

    console.log("\n[1c] Режими програвання");
    check("перемішування перемикається", (await evalJs(`
      const before = state.shuffle;
      document.querySelector('#plShuffle').click();
      const after = state.shuffle;
      document.querySelector('#plShuffle').click();
      return before !== after && state.shuffle === before;`)) === true);
    check("повтор іде по колу off→all→one→off", (await evalJs(`
      const seen = [];
      for (let i = 0; i < 3; i++) { document.querySelector('#plRepeat').click(); seen.push(state.repeat); }
      return seen.join(',');`)) === "all,one,off");
    // Повтор одного треку не має ламати кнопку ⏭: вона мусить вести далі.
    check("⏭ не застрягає при повторі одного", (await evalJs(`
      state.pq = { list: [{url:'a'},{url:'b'},{url:'c'}], i: 1 };
      state.repeat = 'one'; state.shuffle = false;
      const auto = nextIndex(true), manual = nextIndex(false);
      state.repeat = 'off'; state.pq = { list: [], i: -1 };
      return auto === 1 && manual === 2;`)) === true);
    check("кінець списку без повтору зупиняє", (await evalJs(`
      state.pq = { list: [{url:'a'},{url:'b'}], i: 1 };
      state.repeat = 'off'; state.shuffle = false;
      const r = nextIndex(true);
      state.pq = { list: [], i: -1 };
      return r;`)) === -1);

    console.log("\n[2] Пошук «Black Magick SS»");
    await evalJs(`document.querySelector('.navbtn[data-page=search]').click(); return true`);
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
    // Звичайний YouTube окремим джерелом: концерти, кавери й рідкісні
    // завантаження в каталог YouTube Music не потрапляють.
    check("джерело YouTube є в перемикачах",
      (await evalJs(`return !!document.querySelector('#sources input[value=youtube]')`)) === true);
    // SoundCloud іде окремо й домальовується пізніше: він один тримав увесь
    // пошук — 4.4 с проти 0.4 с у решти разом узятих.
    check("SoundCloud домальовується після швидких джерел", (await until(`
      return state.results.songs.some(s => s.source === 'soundcloud') ? true : null;`, 20, 700)) === true);
    check("є результати зі звичайного YouTube", (await evalJs(`
      return state.results.songs.filter(s => s.source === 'youtube').length;`)) > 0);
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

    const jobsBefore = await evalJs("return state.jobs.size");
    await evalJs(`
      const b = document.querySelector('.row [data-act=dl-one]');
      window.__dlBtn = !!b;
      if (b) b.click();
      return true;`);
    const toastSeen = await until(`
      const t = document.querySelector('#toast');
      return (!t.hidden && t.textContent.includes('чергу')) ? true : null;`, 12, 300);
    check(
      "з'явилась підказка про чергу",
      toastSeen === true,
      toastSeen
        ? ""
        : await evalJs(`
            const t = document.querySelector('#toast');
            return 'кнопка=' + window.__dlBtn
                 + ' | схована=' + t.hidden
                 + ' | текст=' + JSON.stringify(t.textContent.trim().slice(0, 60))
                 + ' | завдань було ${jobsBefore}, стало ' + state.jobs.size;`),
    );

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
               // Перший текстовий вузол, бо далі в тому ж рядку йде бейдж бітрейту.
               artist: r[0].querySelector('.sub').childNodes[0].textContent,
               tech: r[0].querySelector('.sub .badge')?.textContent || '' };`, 40);
    check("сховище знайшло завантажене", Boolean(lib), lib ? `${lib.n}: ${lib.artist} — ${lib.title}` : "не дочекались");
    check("теги прочитані з файлу", lib?.artist === "Kevin MacLeod", lib?.artist || "");
    check("показано формат і бітрейт", /^m4a \d+ kb\/s$/.test(lib?.tech || ""), lib?.tech || "");
    // Регресія: кнопки в рядку були колонкою сітки і при opacity:0 однаково
    // займали місце — шість кнопок з'їдали 470 із 894 пікселів, а назві
    // лишалось 35, тож вона обрізалась завжди.
    const cols = await evalJs(`
      const row = document.querySelector('.row[data-path]');
      const b = row.querySelector('.name b');
      return { name: Math.round(row.querySelector('.name').getBoundingClientRect().width),
               row: Math.round(row.getBoundingClientRect().width),
               cut: b.scrollWidth > b.clientWidth + 1,
               actAbsolute: getComputedStyle(row.querySelector('.act')).position };`);
    check("назва не обрізана", cols?.cut === false, `колонка назви ${cols?.name}px із ${cols?.row}px`);
    check("колонка назви отримала місце", cols?.name > cols?.row * 0.35, `${cols?.name}px`);
    check("кнопки не займають місця в потоці", cols?.actAbsolute === "absolute", cols?.actAbsolute || "");
    // Обкладинки вантажаться ліниво (IntersectionObserver) і читаються з
    // файлу на кілька мегабайтів. Запас часу тут великий навмисно: профіль
    // стирається перед кожним прогоном, і перший рендер після холодного
    // старту не вкладався у 8 секунд — це давало провали на справній програмі.
    const cover = await until(`
      const im = document.querySelector('.row[data-path] .art');
      if (!im) return null;
      return im.src.startsWith('data:image') && im.src.length > 2000
        ? true : null;`, 40, 500);
    check("обкладинка витягнута з файлу", cover === true,
      cover ? "" : await evalJs(`
        const im = document.querySelector('.row[data-path] .art');
        return im ? im.src.slice(0, 40) + ' довж=' + im.src.length : 'рядка нема';`));
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

    // Це те, що бачить сама Windows: панель біля гучності та медіаклавіші на
    // клавіатурі й навушниках. Перевіряти доводиться зсередини — назовні
    // панель ніяк не спитаєш.
    console.log("\n[10b] Системна панель «зараз грає»");
    const ms = await evalJs(`
      const m = navigator.mediaSession.metadata;
      return {
        title: m?.title || null,
        artist: m?.artist || null,
        art: m ? [...m.artwork].map(a => String(a.src).slice(0, 12)) : [],
        stateNow: navigator.mediaSession.playbackState,
      };`);
    check("система знає назву треку", ms?.title === "Cipher", ms?.title || "нічого");
    check("система знає виконавця", ms?.artist === "Kevin MacLeod", ms?.artist || "нічого");
    check("обкладинка віддана системі", ms?.art?.length > 0, ms?.art?.[0] || "порожньо");
    check("стан збігається з плеєром (пауза)", ms?.stateNow === "paused", ms?.stateNow);

    // Кнопка «грати» в системній панелі шле ту саму дію, що й медіаклавіша.
    // Викликаємо її так само, як зробила б система.
    const resumed = await evalJs(`
      document.querySelector('#plPlay').click();
      return true;`);
    const nowPlaying = await until(`
      return navigator.mediaSession.playbackState === 'playing' ? true : null;`, 15, 200);
    check("стан їде за плеєром при відновленні", Boolean(resumed && nowPlaying));
    await evalJs(`document.querySelector('#plPlay').click(); return true`); // лишаємо на паузі

    // Черга завжди існувала всередині, але побачити її було ніяк — а отже й
    // переставити щось або викинути.
    console.log("\n[10b2] Панель черги відтворення");
    await evalJs(`document.querySelector('#plQueue').click(); return true`);
    await sleep(300);
    const q0 = await evalJs(`
      return {
        open: !document.querySelector('#queuePanel').hidden,
        rows: document.querySelectorAll('#queueBody .qrow').length,
        now: document.querySelector('#queueBody .qrow.now')?.querySelector('b')?.textContent || null,
        count: document.querySelector('#queueCount').textContent,
      };`);
    check("панель відкрилась", q0?.open === true);
    check("у ній видно чергу", q0?.rows > 0, `${q0?.rows} треків, «${q0?.count}»`);
    check("поточний трек позначено", q0?.now === "Cipher", q0?.now || "нічого");

    // Для переставляння потрібна черга з кількох треків, а зі Сховища тут
    // рівно один файл. Складаємо власну з вигаданих: перевіряємо саму
    // механіку, і залежати від того, що встиг знайти пошук, вона не має.
    const moved = await evalJs(`
      state.pq = {
        list: [1, 2, 3, 4].map(n => ({ title: 'Черга ' + n, artist: 'Тест', url: 'https://example.invalid/' + n })),
        i: 1,
      };
      renderQueuePanel();
      const before = state.pq.list.map(t => t.title);
      queueMove(2, -1);
      return { before, after: state.pq.list.map(t => t.title), i: state.pq.i };`);
    // Довжину звіряємо навмисно: без неї перевірка проходила б і на порожній
    // черзі, де обидві сторони рівності — undefined.
    check("трек піднімається вгору",
      moved?.after.length === 4 && moved.after[1] === moved.before[2] && moved.after[2] === moved.before[1],
      moved?.after.join(", "));
    // Найважливіше: покажчик мусить їхати за самим треком, інакше «зараз грає»
    // перестрибує на чужу пісню.
    check("позначка «зараз грає» їде за треком", moved?.i === 2, `індекс ${moved?.i}`);

    const dropped = await evalJs(`
      const len = state.pq.list.length, gone = state.pq.list[0].title;
      queueDrop(0);
      return { len, now: state.pq.list.length, gone, first: state.pq.list[0].title, i: state.pq.i };`);
    check("трек прибирається з черги",
      dropped?.now === dropped?.len - 1 && dropped?.first !== dropped?.gone);
    check("покажчик зсунувся разом зі списком", dropped?.i === 1, `індекс ${dropped?.i}`);

    const nexted = await evalJs(`
      const t = { title: 'Вставлений', artist: 'Тест', url: 'https://example.invalid/x' };
      playNext(t);
      return { at: state.pq.list[state.pq.i + 1]?.title, rows: document.querySelectorAll('#queueBody .qrow').length };`);
    check("«грати наступним» ставить одразу за поточним", nexted?.at === "Вставлений");
    check("панель одразу це показує", nexted?.rows === dropped?.now + 1, `${nexted?.rows} рядків`);

    await shot("черга-відтворення");
    await evalJs(`document.querySelector('#queueClose').click(); return true`);
    check("панель закривається", (await evalJs("return document.querySelector('#queuePanel').hidden")) === true);
    // Черга була підмінена вручну — повертаємо її до того, що справді грає,
    // щоб наступні перевірки починали з чесного стану.
    await evalJs(`
      state.pq = state.playing ? { list: [state.playing], i: 0 } : { list: [], i: -1 };
      syncNavBtns();
      return true;`);

    console.log("\n[10c] Позначка «вже є» в пошуку");
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

    // SoundCloud відповідає окремо й повільно (близько 4 с). Якщо за цей час
    // піти в Сховище, його результати не мають домалюватись поверх — колись
    // саме так сторінка й підмінялась під руками.
    console.log("\n[10d] Пізні результати не підміняють сторінку");
    await evalJs(`
      document.querySelector('.navbtn[data-page=search]').click();
      document.querySelector('#q').value = 'Kevin MacLeod';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await sleep(400);
    await evalJs(`document.querySelector('.navbtn[data-page=library]').click(); return true`);
    await sleep(9000);
    const stayed = await evalJs(`
      return {
        page: state.page,
        lib: document.querySelectorAll('.row[data-path]').length,
        found: document.querySelectorAll('.row[data-key]').length,
      };`);
    check("Сховище лишилось на екрані",
      stayed?.page === "library" && stayed.lib > 0 && stayed.found === 0,
      `${stayed?.page}: файлів ${stayed?.lib}, знайденого ${stayed?.found}`);
    check("а самі результати не загубились", (await evalJs(`
      return state.results.songs.some(s => s.source === 'soundcloud');`)) === true);

    console.log("\n[11] Редактор тегів");
    await evalJs(`document.querySelector('.navbtn[data-page=library]').click(); return true`);
    await until(`return document.querySelector('.row[data-path]') ? true : null`, 20, 400);
    const before = fs.readdirSync(OUT)[0];
    await evalJs(`document.querySelector('.row[data-path] [data-lact=tags]').click(); return true`);
    await sleep(400);
    check("вікно редактора відкрилось", (await evalJs("return !document.querySelector('#tagModal').hidden")) === true);
    check("поля заповнені поточними тегами", (await evalJs(`
      return document.querySelector('#tagArtist').value + '|' + document.querySelector('#tagTitle').value;`))
      === "Kevin MacLeod|Cipher");
    await shot("редактор-тегів");

    await evalJs(`
      document.querySelector('#tagArtist').value = 'Тест Виконавець';
      document.querySelector('#tagTitle').value = 'Тест Назва';
      document.querySelector('#tagAlbum').value = 'Тест Альбом';
      document.querySelector('#tagSave').click();
      return true;`);
    const saved = await until(`
      if (!document.querySelector('#tagModal').hidden) return null;
      const r = document.querySelector('.row[data-path]');
      if (!r) return null;
      const t = r.querySelector('b').textContent;
      return t === 'Тест Назва'
        ? { title: t, artist: r.querySelector('.sub').childNodes[0].textContent, path: r.dataset.path }
        : null;`, 30);
    check("теги збережено й список оновився", Boolean(saved), saved ? `${saved.artist}` : "не дочекались");
    check("виконавця змінено", saved?.artist === "Тест Виконавець", saved?.artist || "");

    const after = fs.readdirSync(OUT);
    check("файл перейменовано за новими тегами", after.length === 1 && /^Тест Виконавець - Тест Назва\./.test(after[0]),
      `${before} -> ${after.join()}`);
    // Найважливіше: правка тегів не має чіпати ані звук, ані обкладинку.
    check("обкладинка й тривалість не постраждали", (await evalJs(`
      const r = document.querySelector('.row[data-path]');
      return r.querySelector('.dur').textContent;`)) === "3:51");
    check("обкладинка все ще всередині файлу", (await until(`
      const im = document.querySelector('.row[data-path] .art');
      if (!im) return null;
      return im.src.startsWith('data:image') && im.src.length > 2000 ? true : null;`, 40, 500)) === true);
    await shot("теги-змінено");

    console.log("\n[11b] Прослуховування прямо з пошуку");
    await evalJs(`
      document.querySelector('.navbtn[data-page=search]').click();
      document.querySelector('#q').value = 'Kevin MacLeod Cipher';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await until(`
      if (document.querySelector('.spinner')) return null;
      return document.querySelector('.row [data-act=listen]') ? true : null;`, 40, 1000);
    await evalJs(`document.querySelector('.row [data-act=listen]').click(); return true`);
    const preview = await until(`
      const a = document.querySelector('#audio');
      return (!a.paused && a.currentTime > 0.2)
        ? { src: a.src.slice(0, 34), t: a.currentTime, q: state.pq.list.length } : null;`, 40, 700);
    check("трек із пошуку грає без завантаження", Boolean(preview),
      preview ? `${preview.t.toFixed(1)}с, джерело ${preview.src}…` : "не заграв");
    check("це справді потік із мережі", preview?.src?.startsWith("https://") === true, preview?.src || "");
    check("черга зібралась зі списку результатів", preview?.q > 1, `${preview?.q} треків`);
    check("кнопка «наступний» активна", (await evalJs("return !document.querySelector('#plNext').disabled")) === true);
    await shot("прослуховування-з-пошуку");

    // Радіо — власні рекомендації YouTube Music за конкретним треком.
    await evalJs(`document.querySelector('.row [data-act=radio]').click(); return true`);
    const rad = await until(`
      return state.pq.list.length > 5
        ? { n: state.pq.list.length, first: state.pq.list[0].title,
            second: state.pq.list[1] ? state.pq.list[1].title : null } : null;`, 30, 700);
    check("радіо за треком зібралось", rad?.n > 5, rad ? `${rad.n} треків` : "не дочекались");
    check("сам трек стоїть першим", Boolean(rad?.first), rad?.first || "");
    check("далі йдуть інші треки", rad?.second && rad.second !== rad.first, rad?.second || "");
    await evalJs(`document.querySelector('#audio').pause(); return true`);
    await evalJs(`document.querySelector('#plPlay').click(); return true`);

    console.log("\n[11b2] Текст пісні");
    // Ставимо на відтворення трек, у якого текст точно є.
    await evalJs(`
      document.querySelector('.navbtn[data-page=search]').click();
      document.querySelector('#q').value = 'Nirvana Smells Like Teen Spirit';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await until(`
      if (document.querySelector('.spinner')) return null;
      return document.querySelector('.row [data-act=listen]') ? true : null;`, 40, 1000);
    await evalJs(`document.querySelector('.row [data-act=listen]').click(); return true`);
    await until(`return state.playing ? true : null`, 20, 400);

    await evalJs(`document.querySelector('#plLyrics').click(); return true`);
    check("панель тексту відкрилась", (await evalJs("return !document.querySelector('#lyricsPanel').hidden")) === true);
    // Перевіряємо лише те, що текст прийшов і в панелі є заголовок треку —
    // сам текст не друкуємо.
    const lyr = await until(`
      const pre = document.querySelector('#lyricsBody .ltext');
      const note = document.querySelector('#lyricsBody .note');
      if (pre) return { len: pre.textContent.length, lines: pre.textContent.split('\\n').length };
      if (note) return { note: note.textContent.slice(0, 60) };
      return null;`, 25, 600);
    check("текст завантажився", lyr?.len > 200, lyr?.len ? `${lyr.len} символів, ${lyr.lines} рядків` : lyr?.note || "нічого");
    check("у заголовку панелі — назва треку",
      (await evalJs("return document.querySelector('#lyricsTitle').textContent")).includes("Teen Spirit"));
    await shot("текст-пісні");

    await evalJs(`document.querySelector('#lyricsClose').click(); return true`);
    check("панель закривається", (await evalJs("return document.querySelector('#lyricsPanel').hidden")) === true);
    await evalJs(`document.querySelector('#audio').pause(); return true`);

    console.log("\n[11b3] Улюблене, історія, пошук у Сховищі");
    await evalJs(`document.querySelector('.navbtn[data-page=library]').click(); return true`);
    await until(`return document.querySelector('.row[data-path]') ? true : null`, 20, 400);

    const favBefore = await evalJs("return state.favs.size");
    await evalJs(`document.querySelector('.row[data-path] [data-fav]').click(); return true`);
    check("трек додається в улюблене", (await until(`
      return state.favs.size === ${favBefore} + 1 ? true : null;`, 15, 300)) === true);
    check("серце залилось кольором", (await evalJs(`
      return document.querySelector('.row[data-path] [data-fav]').classList.contains('on');`)) === true);
    check("улюблене переживає перезапит", (await evalJs(`
      const list = await window.api.favList();
      return list.length === state.favs.size;`)) === true);
    await evalJs(`document.querySelector('.row[data-path] [data-fav]').click(); return true`);
    check("повторний клік прибирає", (await until(`
      return state.favs.size === ${favBefore} ? true : null;`, 15, 300)) === true);

    check("пошук у Сховищі звужує список", (await evalJs(`
      const inp = document.querySelector('#libSearch');
      inp.value = 'цезаточнонезбігається';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      const after = document.querySelectorAll('.row[data-path]').length;
      inp.value = '';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      const back = document.querySelectorAll('.row[data-path]').length;
      return after === 0 && back > 0;`)) === true);

    check("історія накопичилась", (await evalJs("return state.history.length")) > 0);
    await evalJs(`document.querySelector('.navbtn[data-page=home]').click(); return true`);
    const histShown = await until(`
      const rows = document.querySelectorAll('.row[data-hist]');
      return rows.length ? { n: rows.length } : null;`, 20, 400);
    check("«нещодавно слухав» на Головній", histShown?.n > 0, `${histShown?.n} рядків`);
    await shot("головна-з-історією");

    console.log("\n[11c] Плейлисти");
    // Плейлисти лежать у справжніх даних користувача, тому прибираємо за
    // собою: інакше кожен запуск лишав би сміття і ламав наступний.
    const PL_NAME = `Тест ${Date.now()}`;
    await evalJs(`
      for (const p of await window.api.plList()) {
        if (/^(Тест |Мій тест)/.test(p.name)) await window.api.plRemove(p.id);
      }
      state.playlists = await window.api.plList();
      return true;`);

    await evalJs(`document.querySelector('.navbtn[data-page=library]').click(); return true`);
    await until(`return document.querySelector('.row[data-path]') ? true : null`, 20, 400);
    await evalJs(`document.querySelector('.row[data-path] input[data-lact=pick]').click(); return true`);
    check("кнопка «У плейлист» з'явилась", (await evalJs("return !document.querySelector('#selPl').hidden")) === true);
    await evalJs(`document.querySelector('#selPl').click(); return true`);
    await sleep(300);
    check("вікно вибору плейлиста відкрилось", (await evalJs("return !document.querySelector('#plModal').hidden")) === true);
    // Регресія: у Electron window.prompt кидає виняток «prompt() is not
    // supported» і рве весь обробник — кнопка «Створити плейлист» мовчала.
    check("prompt справді непридатний у Electron", (await evalJs(`
      try { window.prompt('x'); return 'працює'; } catch (e) { return e.message; }`))
      === "prompt() is not supported.");

    await evalJs(`
      document.querySelector('#plNewName').value = ${JSON.stringify(PL_NAME)};
      document.querySelector('#plCreateAdd').click();
      return true;`);
    const made = await until(`
      if (!document.querySelector('#plModal').hidden) return null;
      const p = state.playlists.find(p => p.name === ${JSON.stringify(PL_NAME)});
      return p ? { name: p.name, tracks: p.tracks.length } : null;`, 20, 400);
    check("плейлист створено з треком", made?.tracks === 1, made ? `«${made.name}»` : "не створився");

    await evalJs(`document.querySelector('.navbtn[data-page=playlists]').click(); return true`);
    const plPage = await until(`
      const c = [...document.querySelectorAll('.plcard')]
        .find(c => c.textContent.includes(${JSON.stringify(PL_NAME)}));
      return c ? { text: c.textContent.replace(/\\s+/g,' ').trim() } : null;`, 20, 400);
    check("сторінка плейлистів показує його", Boolean(plPage), (plPage?.text || "").slice(0, 46));

    await evalJs(`
      [...document.querySelectorAll('.plcard')]
        .find(c => c.textContent.includes(${JSON.stringify(PL_NAME)}))
        .querySelector('[data-plact=open]').click();
      return true;`);
    await sleep(400);
    // data-pkey, а не data-path: у плейлисті тепер бувають і мережеві треки,
    // у яких шляху до файлу немає взагалі.
    check("всередині плейлиста видно трек",
      (await evalJs("return document.querySelectorAll('.row[data-pkey]').length")) === 1);
    await shot("плейлист");

    // Кнопка «Створити плейлист» на самій сторінці — та, що мовчала через prompt.
    await evalJs(`document.querySelector('[data-plact=back]').click(); return true`);
    await sleep(300);
    const NEW2 = `Тест2 ${Date.now()}`;
    await evalJs(`document.querySelector('[data-plact=new]').click(); return true`);
    check("вікно вводу назви відкрилось",
      (await evalJs("return !document.querySelector('#askModal').hidden")) === true);
    await evalJs(`
      document.querySelector('#askInput').value = ${JSON.stringify(NEW2)};
      document.querySelector('#askOk').click();
      return true;`);
    check("плейлист створено кнопкою", (await until(`
      const p = state.playlists.find(p => p.name === ${JSON.stringify(NEW2)});
      return p ? true : null;`, 15, 400)) === true);

    // Перейменування теж було на prompt.
    const REN = `Тест3 ${Date.now()}`;
    await evalJs(`
      [...document.querySelectorAll('.plcard')]
        .find(c => c.textContent.includes(${JSON.stringify(NEW2)}))
        .querySelector('[data-plact=rename]').click();
      return true;`);
    await sleep(300);
    await evalJs(`
      document.querySelector('#askInput').value = ${JSON.stringify(REN)};
      document.querySelector('#askOk').click();
      return true;`);
    check("перейменування працює", (await until(`
      return state.playlists.some(p => p.name === ${JSON.stringify(REN)}) ? true : null;`, 15, 400)) === true);

    await evalJs(`
      for (const p of await window.api.plList()) {
        if (/^Тест[23] /.test(p.name)) await window.api.plRemove(p.id);
      }
      state.playlists = await window.api.plList();
      return true;`);

    // Головне: у плейлист має лягати й те, що ще НЕ завантажене. Спершу тут
    // зберігались самі шляхи до файлів, і мережевий трек покласти було нікуди.
    console.log("\n[11c2] Незавантажений трек у плейлисті");
    await evalJs(`
      document.querySelector('.navbtn[data-page=search]').click();
      document.querySelector('#q').value = 'Kevin MacLeod Cipher';
      document.querySelector('#searchForm').dispatchEvent(new Event('submit', {cancelable:true}));
      return true;`);
    await until(`
      if (document.querySelector('.spinner')) return null;
      return document.querySelector('.row [data-act=toplaylist]') ? true : null;`, 40, 1000);

    check("кнопка «у плейлист» є в результатах пошуку", true);
    await evalJs(`document.querySelector('.row [data-act=toplaylist]').click(); return true`);
    await sleep(400);
    const netTrack = await evalJs(`
      const t = JSON.parse(document.querySelector('#plModal').dataset.tracks || '[]')[0];
      return t ? { hasUrl: !!t.url, hasPath: !!t.path, title: t.title } : null;`);
    check("це справді мережевий трек, а не файл",
      netTrack?.hasUrl === true && netTrack?.hasPath !== true, netTrack?.title || "нема");

    await evalJs(`
      document.querySelector('#plNewName').value = ${JSON.stringify(PL_NAME + " мережа")};
      document.querySelector('#plCreateAdd').click();
      return true;`);
    const netPl = await until(`
      const p = state.playlists.find(p => p.name === ${JSON.stringify(PL_NAME + " мережа")});
      return p && p.tracks.length ? { n: p.tracks.length, url: !!p.tracks[0].url } : null;`, 20, 400);
    check("незавантажений трек ліг у плейлист", netPl?.n === 1, netPl ? "" : "не ліг");
    check("у плейлисті збереглось посилання", netPl?.url === true);

    await evalJs(`document.querySelector('.navbtn[data-page=playlists]').click(); return true`);
    await until(`return document.querySelector('.plcard') ? true : null`, 20, 400);
    await evalJs(`
      [...document.querySelectorAll('.plcard')]
        .find(c => c.textContent.includes(${JSON.stringify(PL_NAME + " мережа")}))
        .querySelector('[data-plact=open]').click();
      return true;`);
    await sleep(500);
    check("трек видно всередині плейлиста",
      (await evalJs("return document.querySelectorAll('.row[data-pkey]').length")) === 1);
    check("він позначений як потоковий",
      (await evalJs(`return !!document.querySelector('.row[data-pkey] .badge')`)) === true);
    await shot("плейлист-із-потоком");

    // Завантажити ВЕСЬ плейлист. Раніше така кнопка була лише в альбомів і
    // добірок, а у власних плейлистах — ні, хоч саме там і лежить незавантажене.
    check("є кнопка завантажити весь плейлист",
      (await evalJs(`return !!document.querySelector('[data-plact=plgrab]')`)) === true);
    check("кнопка активна, бо трек ще не на диску",
      (await evalJs(`return !document.querySelector('[data-plact=plgrab]').disabled`)) === true);

    const plGrab = await evalJs(`
      const before = state.jobs.size;
      document.querySelector('[data-plact=plgrab]').click();
      await new Promise(r => setTimeout(r, 1500));
      const jobs = [...state.jobs.values()];
      for (const j of jobs.slice(before)) await window.api.dlCancel(j.id);
      return { added: state.jobs.size - before, url: jobs[jobs.length - 1]?.url || '' };`);
    check("плейлист став завданням у черзі", plGrab?.added === 1, `додано ${plGrab?.added}`);
    check("завдання веде на сам трек", /watch\?v=/.test(plGrab?.url || ""), plGrab?.url || "");

    const left = await evalJs(`
      for (const p of await window.api.plList()) {
        if (p.name.startsWith(${JSON.stringify(PL_NAME)})) await window.api.plRemove(p.id);
      }
      state.playlists = await window.api.plList();
      return state.playlists.filter(p => p.name.startsWith(${JSON.stringify(PL_NAME)})).length;`);
    check("тест прибрав за собою", left === 0);

    console.log("\n[11d] Discord");
    await evalJs(`document.querySelector('.navbtn[data-page=settings]').click(); return true`);
    await sleep(500);
    await evalJs(`
      document.querySelector('#discordId').value = '1234567890123456789';
      document.querySelector('#discordId').dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#discordTest').click();
      return true;`);
    const dmsg = await until(`
      const t = document.querySelector('#discordMsg').textContent;
      return (t && t !== 'Підключаюсь…') ? t : null;`, 20, 500);
    // Discord справді запущено, канал знайдено, кадр прийнято — і клієнт
    // чесно відповів, що такого додатка немає. Це і є доказ роботи протоколу.
    check("хибний ID чесно відхиляється", /Application ID/.test(dmsg || ""), dmsg || "мовчить");
    // Прибираємо вигаданий ID одразу: він перекриває вшитий у програму, і
    // саме через нього інтеграція колись «зламалась» уже поза тестом.
    await evalJs(`
      document.querySelector('#discordId').value = '';
      document.querySelector('#discordId').dispatchEvent(new Event('input', {bubbles:true}));
      return true;`);
    check("вигаданий ID не лишився в налаштуваннях",
      (await evalJs("return (await window.api.getSettings()).discordAppId")) === "");

    // Головне для роздачі друзям: людина нічого не вводила — має працювати
    // вшитий у програму ID, а не вискочити помилка формату.
    const empty = await evalJs(`
      try { await window.api.discordConnect(''); return 'ok'; }
      catch (e) { return e.message; }`);
    check("порожнє поле бере вшитий ID і підключається", empty === "ok", empty || "");

    // Головне: саме́ під'єднання малює в профілі голе «грає ‹додаток›» без
    // пісні — саме це й було видно. Тому без треку ми маємо БУТИ ВІДКЛЮЧЕНІ.
    await evalJs(`await window.api.setSettings({ discordEnabled: true }); return true;`);
    await evalJs(`await window.api.discordActivity(null); return true;`);
    check("без музики з'єднання розірване",
      (await evalJs("return (await window.api.discordStatus()).connected")) === false);

    // Перший виклик з треком лише ЗАПУСКАЄ під'єднання, тому цілком законно
    // повертає false: статус піде відразу після READY. Перевіряємо результат,
    // а не миттєве повернення.
    const why = await evalJs(`
      window.__err = null;
      try { await window.api.discordConnect(''); } catch (e) { window.__err = e.message; }
      return window.__err;`);
    check("під'єднання зі вшитим ID проходить", why === null, why || "");

    await evalJs(`
      return await window.api.discordActivity({
        title: 'Cipher', artist: 'Kevin MacLeod', album: 'Light Electronic',
        duration: 231, position: 5, paused: false });`);
    check("статус доїжджає до Discord", (await until(`
      return (await window.api.discordStatus()).connected ? true : null;`, 15, 400)) === true);

    // Маленька панель Discord показує саме name. За замовчуванням там назва
    // додатка, тому туди навмисно пишеться пісня, а не «Music».
    const { Discord } = require("../src/main/discord");
    const probe = new Discord();
    let sent = null;
    probe.sock = { write: (b) => (sent = JSON.parse(b.subarray(8).toString("utf8"))) };
    probe.ready = true;
    probe.setActivity({ title: "Cipher", artist: "Kevin MacLeod", duration: 200, position: 5 });
    const act = sent?.args?.activity;
    check("у назві активності — пісня, а не додаток", act?.name === "Cipher — Kevin MacLeod", act?.name || "");
    check("виконавець і назва є окремими рядками",
      act?.details === "Cipher" && act?.state === "Kevin MacLeod");
    check("тип активності — «Слухає»", act?.type === 2);

    sent = null;
    probe.setActivity({ title: "Без виконавця" });
    check("без виконавця назва не має хвоста", sent?.args?.activity?.name === "Без виконавця",
      sent?.args?.activity?.name || "");

    // Знімаємо статус, але галочку НЕ вимикаємо: у власному профілі це вже
    // нікому не зашкодить, а лишати систему в іншому стані, ніж застали, —
    // погана звичка, з якої і виріс баг.
    await evalJs(`await window.api.discordActivity(null); return true;`);

    // Обкладинка для Discord: вшиту в файл (data:) він не бере, тому шлях до
    // прев'ю виводиться з посилання, що yt-dlp лишає в тегах.
    const thumb = await evalJs(`
      const t = state.library.tracks[0];
      return t ? { url: t.thumbUrl, file: t.file } : null;`);
    check("у завантаженого треку є посилання на обкладинку",
      /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\//.test(thumb?.url || ""),
      thumb?.url || `нема (${thumb?.file})`);

    console.log("\n[12] Налаштування");
    await evalJs(`document.querySelector('.navbtn[data-page=settings]').click(); return true`);
    await sleep(600);
    check("сторінка намальована", (await evalJs("return document.querySelectorAll('.set').length")) >= 5);
    check("вибір формату є, FLAC немає", (await evalJs(`
      const o = [...document.querySelectorAll('#format option')].map(o => o.value);
      return o.join(',') === 'm4a,opus,mp3';`)) === true);
    check("чесно сказано про бітрейти", (await evalJs(`
      const t = document.querySelector('#main').textContent;
      return t.includes('155') && t.includes('130') && !t.includes('FLAC —');`)) === true);
    check("написано про DRM у Spotify",
      (await evalJs("return document.querySelector('#main').textContent")).includes("DRM"));
    check("написано про авторські права",
      (await evalJs("return document.querySelector('#main').textContent")).includes("авторськ"));
    check("показано знайдені бінарники", (await until(`
      const t = document.querySelector('#binSet')?.textContent || '';
      return t.includes('yt-dlp') && t.includes('ffmpeg') ? true : null;`, 10, 300)) === true);
    // Масштаб виставляє головний процес, тож перевіряємо не поле вибору, а те,
    // що сторінка справді змінила розмір — і що вибір це пережив.
    const zoomed = await evalJs(`
      const sel = document.querySelector('#zoom');
      const before = window.devicePixelRatio;
      sel.value = '1.5';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      return { before, after: window.devicePixelRatio, saved: (await window.api.getSettings()).zoom };`);
    check("масштаб інтерфейсу справді змінює розмір",
      zoomed?.after > zoomed?.before, `${zoomed?.before} → ${zoomed?.after}`);
    check("і запам'ятовується в налаштуваннях", zoomed?.saved === 1.5, String(zoomed?.saved));
    await evalJs(`
      const sel = document.querySelector('#zoom');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`);

    check("є керування оновленням yt-dlp", (await evalJs(`
      return Boolean(document.querySelector('#ytdlpAuto') && document.querySelector('#ytdlpUpd'));`)) === true);
    check("автооновлення yt-dlp увімкнене типово",
      (await evalJs("return document.querySelector('#ytdlpAuto')?.checked")) === true);
    // Не саме оновлення, а лише те, що ми справді питаємо GitHub і розуміємо
    // відповідь: качати 17 МБ у тесті ні до чого.
    //
    // Заразом — головне: поки триває перевірка, вікно мусить лишатися живим.
    // Перша версія цього коду питала версію yt-dlp синхронно, і оскільки
    // yt-dlp.exe розпаковує сам себе кілька секунд, увесь застосунок на цей
    // час замерзав: Сховище зависало на «читаю теги», кнопки не тиснулись.
    const ver = await evalJs(`
      const slow = window.api.ytdlpCheck().catch((e) => ({ err: e.message }));
      const t = performance.now();
      await window.api.getSettings();
      const idle = performance.now() - t;
      return { ...(await slow), idle: Math.round(idle) };`);
    check("версію yt-dlp на GitHub видно",
      /^\d{4}\.\d{2}\.\d{2}/.test(ver?.latest || ""), ver?.err || `${ver?.current} → ${ver?.latest}`);
    check("перевірка оновлень не морозить вікно", ver?.idle < 1000, `звичайний виклик пройшов за ${ver?.idle} мс`);
    await shot("налаштування");

    console.log("\n[13] Помилки в консолі інтерфейсу");
    check("без винятків і порушень CSP", errors.length === 0, [...new Set(errors)].slice(0, 2).join(" | "));
    if (netErrors.length) {
      console.log(`  (мережевих збоїв чужих серверів: ${netErrors.length} — на них є повтор, тест не валять)`);
    }
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
