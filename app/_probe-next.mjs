import { spawn } from "child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------- 1. Фото виконавця для результатів MusicBrainz ----------
console.log("=== фото виконавця ===");

console.log("\n-- Deezer (публічний, без ключа)");
for (const q of ["Black Magick SS", "Pink Floyd", "Океан Ельзи"]) {
  try {
    const j = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=1`).then((r) => r.json());
    const a = j.data?.[0];
    console.log(`  ${q.padEnd(18)} ->`, a ? `${a.name} | ${a.picture_medium}` : "нема");
  } catch (e) {
    console.log(`  ${q.padEnd(18)} -> ПРОВАЛ: ${e.message}`);
  }
}

console.log("\n-- MusicBrainz -> Wikidata -> зображення");
try {
  const mbid = "ca10f13e-0a01-4641-981f-eceea2c1df5e"; // Black Magick SS
  const rel = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`, {
    headers: { "User-Agent": "MusicGrabber/1.0 ( test )" },
  }).then((r) => r.json());
  const rels = (rel.relations || []).map((r) => `${r.type}: ${r.url?.resource}`);
  console.log("  посилання:", rels.slice(0, 8).join("\n             ") || "нема");
} catch (e) {
  console.log("  ПРОВАЛ:", e.message);
}

// ---------- 2. Прослуховування без завантаження ----------
console.log("\n=== прямий потік для попереднього прослуховування ===");

function ytdlpG(url, fmt) {
  return new Promise((res) => {
    const c = spawn("py", ["-m", "yt_dlp", "-f", fmt, "-g", "--no-warnings", url], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let o = "", e = "";
    c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", () => res({ url: o.trim().split("\n")[0], err: e.trim() }));
  });
}

const t0 = Date.now();
const g = await ytdlpG("https://www.youtube.com/watch?v=N0KuBFK9r24", "bestaudio[ext=m4a]/bestaudio");
console.log(`  yt-dlp -g за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
console.log("  URL:", g.url ? g.url.slice(0, 90) + "…" : "НЕМА " + g.err.slice(0, 120));

if (g.url) {
  // Плеєр у браузері качає шматками через Range — перевіряємо саме так.
  try {
    const r = await fetch(g.url, { headers: { "user-agent": UA, range: "bytes=0-65535" } });
    console.log("  Range-запит  :", r.status, r.headers.get("content-type"), r.headers.get("content-range") || "");
    console.log("  CORS дозволяє:", r.headers.get("access-control-allow-origin") || "заголовка нема");
    const buf = await r.arrayBuffer();
    console.log("  отримано     :", buf.byteLength, "байт");
  } catch (e) {
    console.log("  ПРОВАЛ:", e.message);
  }
}

console.log("\n-- те саме для SoundCloud");
const g2 = await ytdlpG("https://soundcloud.com/perturbator/perturbator-future-club", "bestaudio");
console.log("  URL:", g2.url ? g2.url.slice(0, 90) + "…" : "НЕМА " + g2.err.slice(0, 120));
