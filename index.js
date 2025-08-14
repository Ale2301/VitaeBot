require("dotenv").config();
require("./keep_alive.js");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
} = require("discord.js");
const { Pool } = require("pg");

// ---------- Config DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Datos iniciales ----------
const BOSSES_INIT = [
  ["testing", 1, 3],
  ["golemplatadf", 33, 46],
  ["golemplatadz", 33, 46],
  ["golemorodf", 36, 61],
  ["golemorodz", 36, 61],
  ["goleminferdf", 42, 70],
  ["goleminferdz", 42, 70],
  ["goleminferabismo", 42, 70],
  ["gorgona", 60, 120],
  ["abbysaria", 210, 540],
  ["garveloth", 30, 45],
  ["djinn", 420, 900],
  ["lilith", 120, 210],
  ["eishner", 540, 1080],
  ["archimago", 540, 1080],
];

// ---------- Utilidades ----------
function nowMs() {
  return Date.now();
}
function minutes(ms) {
  return ms / 60000;
}
function fmtMinutes(m) {
  if (m < 1) return `${Math.max(0, Math.round(m * 60))}s`;
  const total = Math.max(0, Math.round(m));
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return h === 0 ? `${mm}m` : `${h}h ${mm}m`;
}
function normalizeName(s) {
  return s.trim().toLowerCase();
}

// ---------- SQL helpers ----------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bosses (
      name TEXT PRIMARY KEY,
      min_start INT NOT NULL,
      min_end INT NOT NULL,
      last_kill BIGINT
    )
  `);
  for (const [name, minS, minE] of BOSSES_INIT) {
    await pool.query(
      `INSERT INTO bosses (name, min_start, min_end, last_kill)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (name) DO NOTHING`,
      [name, minS, minE]
    );
  }
}
async function getAllBosses() {
  return (await pool.query(`SELECT * FROM bosses ORDER BY name ASC`)).rows;
}
async function getBossByName(name) {
  return (
    (
      await pool.query(`SELECT * FROM bosses WHERE name = $1`, [
        normalizeName(name),
      ])
    ).rows[0] || null
  );
}
async function upsertBoss(name, minStart, minEnd) {
  await pool.query(
    `INSERT INTO bosses (name, min_start, min_end, last_kill)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (name) DO UPDATE
     SET min_start = EXCLUDED.min_start, min_end = EXCLUDED.min_end`,
    [normalizeName(name), minStart, minEnd]
  );
}
async function registerKill(name, whenMs = nowMs()) {
  const res = await pool.query(
    `UPDATE bosses SET last_kill = $1 WHERE name = $2 RETURNING *`,
    [whenMs, normalizeName(name)]
  );
  return res.rows[0] || null;
}

// ---------- Notificaciones programadas ----------
const activeTimers = new Map();

function cancelWindowNotifications(bossName) {
  const sKey = `${bossName}-start`;
  const eKey = `${bossName}-end`;
  if (activeTimers.has(sKey)) {
    clearTimeout(activeTimers.get(sKey));
    activeTimers.delete(sKey);
  }
  if (activeTimers.has(eKey)) {
    clearTimeout(activeTimers.get(eKey));
    activeTimers.delete(eKey);
  }
}

function scheduleWindowNotifications(boss) {
  cancelWindowNotifications(boss.name);
  if (!boss.last_kill) return;

  const now = nowMs();
  const startMs = Number(boss.last_kill) + boss.min_start * 60000;
  const endMs = Number(boss.last_kill) + boss.min_end * 60000;

  const startDelay = startMs - now;
  const endDelay = endMs - now;

  if (startDelay > 0) {
    const id = setTimeout(() => {
      client.channels.cache
        .get(process.env.CHANNEL_ID)
        ?.send(`⚡ **${boss.name}** entra en ventana de respawn ahora!`);
    }, startDelay);
    activeTimers.set(`${boss.name}-start`, id);
  }
  if (endDelay > 0) {
    const id = setTimeout(() => {
      client.channels.cache
        .get(process.env.CHANNEL_ID)
        ?.send(`⏳ Ventana de **${boss.name}** cerrada!`);
    }, endDelay);
    activeTimers.set(`${boss.name}-end`, id);
  }
}

// ---------- Lógica de timers visuales ----------
function computeStatus(b, now = nowMs()) {
  if (!b.last_kill)
    return { status: "Sin datos", detail: "Nunca registrado", color: 0x777777 };
  const elapsed = minutes(now - Number(b.last_kill));
  if (elapsed < b.min_start) {
    return {
      status: "Esperando ventana",
      detail: `Puede spawnear en: ${fmtMinutes(b.min_start - elapsed)}`,
      color: 0x3399ff,
    };
  }
  if (elapsed <= b.min_end) {
    return {
      status: "En ventana",
      detail: `Spawnea como máximo en: ${fmtMinutes(b.min_end - elapsed)}`,
      color: 0xffcc00,
    };
  }
  return {
    status: "Fuera de ventana",
    detail: `Ya debería haber spawneado. Si no está, alguien más lo mató.`,
    color: 0x33cc66,
  };
}

function buildTimersEmbed(bosses) {
  const embed = new EmbedBuilder()
    .setTitle("⏳ Timers de Respawn")
    .setTimestamp();

  const now = nowMs();

  // Mapa de prioridad: menor número → más arriba
  const priority = {
    "En ventana": 1,
    "Fuera de ventana": 2, // atrasados
    "Esperando ventana": 3,
    "Sin datos": 4,
  };

  // Enriquecer cada boss con su info y ordenar
  const enriched = bosses
    .map((b) => {
      const info = computeStatus(b, now);
      return { ...b, ...info };
    })
    .sort((a, b) => priority[a.status] - priority[b.status]);

  // El color lo tomamos del primer boss en la lista
  if (enriched.length > 0) {
    embed.setColor(enriched[0].color);
  }

  // Agregar campos ya ordenados
  enriched.forEach((b) => {
    embed.addFields({
      name: b.name,
      value: `${b.status} — ${b.detail}`,
      inline: true,
    });
  });

  return embed;
}

// ---------- Bot ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`✅ Logueado como ${client.user.tag}`);
  // Programar timers para todos los bosses que tengan last_kill
  const bosses = await getAllBosses();
  bosses.forEach(scheduleWindowNotifications);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (process.env.CHANNEL_ID && msg.channel.id !== process.env.CHANNEL_ID)
    return;

  const content = msg.content.trim();
  const lower = content.toLowerCase();

  if (lower === "timers") {
    const bosses = await getAllBosses();
    return msg.channel.send({ embeds: [buildTimersEmbed(bosses)] });
  }

  if (lower.startsWith("kill ")) {
    const name = normalizeName(content.slice(5));
    const updated = await registerKill(name);
    if (updated) {
      msg.reply(`Registrado kill de **${name}**.`);
      scheduleWindowNotifications(updated); // Programar nuevos avisos
    } else {
      msg.reply(`No encontré el boss **${name}**.`);
    }
    return;
  }

  if (lower.startsWith("addboss ")) {
    const parts = content.split(/\s+/);
    if (parts.length < 4)
      return msg.reply("Uso: addboss <name> <min_start> <min_end>");
    const name = parts[1],
      minS = parseInt(parts[2]),
      minE = parseInt(parts[3]);
    await upsertBoss(name, minS, minE);
    msg.reply(`Boss **${name}** configurado [${minS}-${minE}]`);
    const b = await getBossByName(name);
    if (b.last_kill) scheduleWindowNotifications(b);
    return;
  }

  const maybeBoss = await getBossByName(lower);
  if (maybeBoss) {
    const updated = await registerKill(maybeBoss.name);
    msg.reply(`Registrado kill de **${maybeBoss.name}**.`);
    scheduleWindowNotifications(updated);
  }
});

// ---------- Boot ----------
(async () => {
  await initDB();
  await client.login(process.env.TOKEN);
})();
