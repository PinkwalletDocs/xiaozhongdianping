/**
 * 从多个 Twitter 账号的粉丝中抓取：中文名 + 粉丝数>500，新增到 KOL 榜单
 * 支持: binancezh, heyibinance, cz_binance
 * 运行: node scripts/discover-multi-sources.js
 */

require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");

const SOURCE_HANDLES = ["binancezh", "heyibinance", "cz_binance"];
const MIN_FOLLOWERS = Number(process.env.MIN_FOLLOWERS) || 500;
const TARGET_KOLS = 1000;
function resolveDataDir() {
  if (process.env.DATA_DIR && String(process.env.DATA_DIR).trim()) {
    return path.resolve(String(process.env.DATA_DIR).trim());
  }
  return path.join(__dirname, "..", "data");
}
const DB_PATH = path.join(resolveDataDir(), "app.db");
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_TWITTER_HOST =
  process.env.RAPIDAPI_TWITTER_HOST || "twittr-v2-fastest-twitter-x-api-150k-requests-for-15.p.rapidapi.com";
const RAPIDAPI_FOLLOWERS_HOST = process.env.RAPIDAPI_FOLLOWERS_HOST || "twitter-social.p.rapidapi.com";

const CN_REG = /[\u4e00-\u9fff]/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function hasChinese(s) {
  return s && CN_REG.test(String(s));
}

const dbCache = new Database(DB_PATH);
dbCache.exec(`
  CREATE TABLE IF NOT EXISTS handle_id_cache (
    handle TEXT PRIMARY KEY,
    rest_id TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
function saveHandleToId(handle, restId) {
  try {
    dbCache
      .prepare(
        "INSERT INTO handle_id_cache (handle, rest_id, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(handle) DO UPDATE SET rest_id = excluded.rest_id, updated_at = datetime('now')"
      )
      .run(String(handle || "").toLowerCase(), String(restId || ""));
  } catch (_e) {}
}

async function getUserByUsername(handle) {
  const res = await fetch(
    `https://${RAPIDAPI_TWITTER_HOST}/user/by/username/${encodeURIComponent(handle)}`,
    {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_TWITTER_HOST
      }
    }
  );
  const data = await res.json().catch(() => ({}));
  const user = data?.data?.user?.result;
  const rid = user?.rest_id || user?.id;
  if (rid) saveHandleToId(handle, rid);
  return { res, data, user };
}

function normalizeUser(u) {
  if (!u) return null;
  const legacy = u?.legacy || {};
  const handle = (legacy?.screen_name || u?.screen_name || u?.username || "").toLowerCase();
  const name = legacy?.name || u?.name || "";
  const description = legacy?.description || u?.description || "";
  const followersCount = legacy?.followers_count ?? u?.followers_count ?? u?.followersCount ?? 0;
  return { handle, name, description, followersCount, raw: u };
}

async function getFollowersPaginated(handle) {
  const hUser = encodeURIComponent(handle);
  const allUsers = [];
  const seenHandles = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const url = `https://${RAPIDAPI_FOLLOWERS_HOST}/api/v1/twitter/user/followers?username=${hUser}&count=${PAGE_SIZE}${cursorParam}`;
    try {
      const res = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_FOLLOWERS_HOST
        }
      });
      if (!res.ok) break;
      const data = await res.json().catch(() => ({}));
      let users = data?.body || data?.users || data?.followers || [];
      for (const u of users) {
        const mapped = u?.legacy ? u : {
          legacy: {
            screen_name: u.username || u.screen_name,
            name: u.name,
            description: u.description || u.bio || "",
            followers_count: u.followers_count ?? u.followersCount ?? 0
          },
          ...u
        };
        const norm = normalizeUser(mapped);
        if (norm?.handle && !seenHandles.has(norm.handle)) {
          seenHandles.add(norm.handle);
          allUsers.push(norm);
        }
      }
      if (!users?.length) break;
      cursor = data?.meta?.cursor || data?.next_cursor || data?.cursor?.next;
      if (!cursor) break;
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.warn(`[${handle}] page ${page} error:`, e.message);
      break;
    }
  }
  return allUsers;
}

async function main() {
  if (!RAPIDAPI_KEY) {
    return { ok: false, error: "RAPIDAPI_KEY not configured", added: 0 };
  }
  const db = new Database(DB_PATH);
  const insertKol = db.prepare(
    "INSERT OR IGNORE INTO kols (handle, display_name, twitter_uid, followers, tags, intro, is_lead_trade) VALUES (?, ?, ?, ?, ?, ?, 0)"
  );
  let totalAdded = 0;
  const existingHandles = new Set(
    db.prepare("SELECT lower(handle) as h FROM kols").all().map((r) => r.h)
  );

  for (const source of ["heyibinance", "cz_binance"]) {
    if (existingHandles.has(source.toLowerCase())) continue;
    const { user } = await getUserByUsername(source);
    const name = user?.core?.name || user?.legacy?.name || user?.name || source;
    const desc = (user?.legacy?.description || user?.description || "").slice(0, 500);
    const count = user?.legacy?.followers_count ?? user?.followers_count ?? 0;
    insertKol.run(source, name || source, `@${source}`, Number(count) || 0, "binance", desc);
    if (db.prepare("SELECT changes()").get()["changes()"] > 0) {
      totalAdded++;
      existingHandles.add(source.toLowerCase());
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  for (const source of SOURCE_HANDLES) {
    const tag = source;
    const followers = await getFollowersPaginated(source);
    const qualified = followers.filter(
      (u) => u && hasChinese(u.name) && Number(u.followersCount) >= MIN_FOLLOWERS
    );
    console.log(`[${source}] fetched ${followers.length}, qualified ${qualified.length}`);
    for (const u of qualified) {
      if (existingHandles.has(u.handle.toLowerCase())) continue;
      const displayName = u.name || u.handle;
      const intro = (u.description || "").slice(0, 500);
      const followersCount = Number(u.followersCount) || 0;
      insertKol.run(u.handle, displayName, `@${u.handle}`, followersCount, tag, intro);
      if (db.prepare("SELECT changes()").get()["changes()"] > 0) {
        totalAdded++;
        existingHandles.add(u.handle.toLowerCase());
      }
      if (db.prepare("SELECT COUNT(*) as c FROM kols").get().c >= TARGET_KOLS) break;
    }
    if (db.prepare("SELECT COUNT(*) as c FROM kols").get().c >= TARGET_KOLS) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalCount = db.prepare("SELECT COUNT(*) as c FROM kols").get().c;
  db.close();
  return {
    ok: true,
    added: totalAdded,
    totalKols: finalCount,
    targetReached: finalCount >= TARGET_KOLS
  };
}

if (require.main === module) {
  main()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { main };
