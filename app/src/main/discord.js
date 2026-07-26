"use strict";
/**
 * Показ поточного треку в статусі Discord (Rich Presence).
 *
 * Пишемо протокол напряму, без бібліотеки: офіційна discord-rpc давно
 * покинута, а тут усього-на-всього іменований канал і кадри вигляду
 * [опкод: int32 LE][довжина: int32 LE][JSON].
 *
 * Discord показує НАЗВУ ЗАРЕЄСТРОВАНОГО ДОДАТКА, а не наш заголовок вікна,
 * тому користувач мусить створити власний Application і вписати його ID —
 * без цього клієнт відповідає «Invalid Client ID» і статус не з'являється.
 */

const net = require("net");
const { EventEmitter } = require("events");

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Discord слухає перший вільний канал із десяти. */
function pipePath(i) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\discord-ipc-${i}`
    : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp"}/discord-ipc-${i}`;
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class Discord extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.ready = false;
    this.clientId = null;
    this.buf = Buffer.alloc(0);
    this.lastActivity = null;
    this.retryTimer = null;
    this.nonce = 0;
  }

  /** @returns {Promise<void>} відхиляється з людською причиною, якщо не вийшло */
  connect(clientId) {
    this.clientId = String(clientId || "").trim();
    this.disconnect();
    if (!/^\d{17,25}$/.test(this.clientId)) {
      return Promise.reject(new Error("ID додатка Discord має бути числом з 17–25 цифр"));
    }

    return new Promise((resolve, reject) => {
      let i = 0;
      const tryPipe = () => {
        if (i > 9) return reject(new Error("Discord не запущено (канал discord-ipc не знайдено)"));
        const sock = net.createConnection(pipePath(i));
        const onFail = () => {
          sock.destroy();
          i++;
          tryPipe();
        };
        sock.once("error", onFail);
        sock.once("connect", () => {
          sock.removeListener("error", onFail);
          this._attach(sock, resolve, reject);
          sock.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
        });
      };
      tryPipe();
    });
  }

  _attach(sock, resolve, reject) {
    this.sock = sock;
    let settled = false;

    sock.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      // Кадри можуть приходити склеєними або порізаними — розбираємо циклом.
      while (this.buf.length >= 8) {
        const op = this.buf.readInt32LE(0);
        const len = this.buf.readInt32LE(4);
        if (this.buf.length < 8 + len) break;
        const body = this.buf.subarray(8, 8 + len).toString("utf8");
        this.buf = this.buf.subarray(8 + len);

        let msg = {};
        try {
          msg = JSON.parse(body);
        } catch {
          continue;
        }

        if (op === OP_PING) {
          sock.write(encode(OP_PONG, msg));
          continue;
        }
        if (op === OP_CLOSE) {
          const why = msg.message || "Discord закрив з'єднання";
          if (!settled) {
            settled = true;
            reject(new Error(why));
          }
          this.emit("closed", why);
          this.disconnect();
          continue;
        }
        if (msg.evt === "READY") {
          this.ready = true;
          this.emit("ready", msg.data?.user || null);
          if (!settled) {
            settled = true;
            resolve();
          }
          // Те, що грало до підключення, показуємо одразу.
          if (this.lastActivity !== null) this.setActivity(this.lastActivity);
          continue;
        }
        if (msg.evt === "ERROR" && !settled) {
          settled = true;
          reject(new Error(msg.data?.message || "Discord відхилив підключення"));
        }
      }
    });

    sock.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
      this.emit("closed", e.message);
      this.ready = false;
    });

    sock.on("close", () => {
      this.ready = false;
      this.sock = null;
    });
  }

  /**
   * @param {null|{title: string, artist?: string, album?: string, image?: string,
   *               duration?: number, position?: number, paused?: boolean}} track
   */
  setActivity(track) {
    this.lastActivity = track;
    if (!this.sock || !this.ready) return false;

    let activity = null;
    if (track) {
      const title = String(track.title || "").slice(0, 128);
      const artist = String(track.artist || "").slice(0, 128);

      activity = {
        type: 2, // «Слухає» замість «Грає»
        // Маленька панель Discord показує САМЕ name — за замовчуванням там
        // стоїть назва зареєстрованого додатка, тобто просто «Music».
        // Перевірено, що клієнт приймає власне значення, тож пишемо туди
        // пісню: інакше друзі бачать назву програми, а не те, що ти слухаєш.
        name: (artist ? `${title} — ${artist}` : title).slice(0, 128) || "Music",
        // details і state показуються в картці профілю, окремими рядками.
        details: title,
        state: artist || "невідомий виконавець",
      };

      if (track.album) {
        activity.assets = { large_text: String(track.album).slice(0, 128) };
      }
      // Discord приймає і зовнішнє посилання на картинку, і ключ ресурсу.
      if (track.image && /^https?:\/\//.test(track.image)) {
        activity.assets = { ...(activity.assets || {}), large_image: track.image };
      }

      // Смужку часу показуємо лише коли грає: на паузі вона б «бігла» далі.
      if (!track.paused && track.duration > 0) {
        const now = Date.now();
        const pos = Math.max(0, Math.min(track.duration, track.position || 0));
        activity.timestamps = {
          start: Math.round(now - pos * 1000),
          end: Math.round(now + (track.duration - pos) * 1000),
        };
      }
    }

    try {
      this.sock.write(
        encode(OP_FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity },
          nonce: String(++this.nonce),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.ready = false;
    this.buf = Buffer.alloc(0);
    if (this.sock) {
      try {
        this.sock.destroy();
      } catch {
        /* уже закритий */
      }
      this.sock = null;
    }
  }

  get connected() {
    return Boolean(this.sock && this.ready);
  }
}

module.exports = { Discord, encode, pipePath };
