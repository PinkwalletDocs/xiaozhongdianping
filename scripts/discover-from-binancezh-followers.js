/**
 * 从 @binancezh 的粉丝列表中抓取中文名关注者，新增到 KOL 榜单和数据库
 * 运行: node scripts/discover-from-binancezh-followers.js
 * 或通过管理后台 POST /api/admin/discover-from-binancezh (需登录)
 */

require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");

const SOURCE_HANDLE = "binancezh";
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
const RAPIDAPI_FOLLOWING_HOST = process.env.RAPIDAPI_FOLLOWING_HOST || RAPIDAPI_TWITTER_HOST;
const RAPIDAPI_TWITTER_X_HOST = process.env.RAPIDAPI_TWITTER_X_HOST || "twitter-x.p.rapidapi.com";
const RAPIDAPI_FOLLOWERS_HOST = process.env.RAPIDAPI_FOLLOWERS_HOST || "twitter-social.p.rapidapi.com";

const CN_REG = /[\u4e00-\u9fff]/;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

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

async function getFollowers(handle, userId) {
  const hUser = encodeURIComponent(handle);
  const hId = userId ? encodeURIComponent(userId) : hUser;
  const allUsers = [];
  const seenHandles = new Set();
  const fetchPage = async (url, host) => {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": host || RAPIDAPI_TWITTER_HOST
      }
    });
    if (!res.ok) return { users: [], nextCursor: null };
    const data = await res.json().catch(() => ({}));
    let users = [];
    const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions;
    if (instructions?.length) {
      const entries = instructions
        ?.flatMap((i) => i?.entries || (i?.entry ? [i.entry] : []))
        ?.filter((e) => e?.content?.itemContent?.user_results) || [];
      users = entries.map((e) => e?.content?.itemContent?.user_results?.result).filter(Boolean);
    } else {
      users =
        data?.body ||
        data?.data?.users ||
        data?.data?.followers ||
        data?.users ||
        data?.followers ||
        data?.data?.data ||
        (Array.isArray(data?.data) ? data.data : []) ||
        (Array.isArray(data) ? data : []);
    }
    const nextCursor = data?.meta?.cursor || data?.next_cursor || data?.nextCursor || data?.cursor?.next;
    return { users, nextCursor };
  };
  const tryTwitterSocialPaginated = async () => {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const url = `https://${RAPIDAPI_FOLLOWERS_HOST}/api/v1/twitter/user/followers?username=${hUser}&count=${PAGE_SIZE}${cursorParam}`;
      const { users, nextCursor } = await fetchPage(url, RAPIDAPI_FOLLOWERS_HOST);
      for (const u of users) {
        const mapped = u?.legacy ? u : { legacy: { screen_name: u.username || u.screen_name, name: u.name, description: u.description || u.bio || "", followers_count: u.followers_count || u.followersCount }, ...u };
        const norm = normalizeUser(mapped);
        if (norm?.handle && !seenHandles.has(norm.handle)) {
          seenHandles.add(norm.handle);
          allUsers.push(norm);
        }
      }
      if (!users?.length) break;
      cursor = nextCursor;
      if (!cursor) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return allUsers;
  };
  const r = await tryTwitterSocialPaginated();
  if (r.length > 0) return r;
  const endpoints = [
    [`https://${RAPIDAPI_FOLLOWERS_HOST}/api/v1/twitter/user/followers?username=${hUser}&count=${PAGE_SIZE}`, RAPIDAPI_FOLLOWERS_HOST],
    [`https://${RAPIDAPI_TWITTER_X_HOST}/user/followers?user_id=${hId}`, RAPIDAPI_TWITTER_X_HOST],
    [`https://${RAPIDAPI_FOLLOWING_HOST}/followers/${hId}`, RAPIDAPI_FOLLOWING_HOST],
    [`https://${RAPIDAPI_FOLLOWING_HOST}/user/followers/${hId}`, RAPIDAPI_FOLLOWING_HOST],
    [`https://${RAPIDAPI_FOLLOWING_HOST}/get-followers?username=${hUser}`, RAPIDAPI_FOLLOWING_HOST],
    [`https://${RAPIDAPI_FOLLOWING_HOST}/followers/list?screen_name=${hUser}`, RAPIDAPI_FOLLOWING_HOST]
  ];
  const fetchApi = (url, host) =>
    fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": host || RAPIDAPI_TWITTER_HOST
      }
    });
  for (const [url, host] of endpoints) {
    try {
      const res = await fetchApi(url, host);
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      let users = [];
      const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions;
      if (instructions?.length) {
        const entries =
          instructions
            ?.flatMap((i) => i?.entries || (i?.entry ? [i.entry] : []))
            ?.filter((e) => e?.content?.itemContent?.user_results) || [];
        users = entries.map((e) => e?.content?.itemContent?.user_results?.result).filter(Boolean);
      } else {
        users =
          data?.data?.users ||
          data?.data?.followers ||
          data?.users ||
          data?.followers ||
          data?.data?.data ||
          (Array.isArray(data?.data) ? data.data : []) ||
          (Array.isArray(data) ? data : []);
      }
      if (users?.length > 0) {
        return users.map((u) => {
          const mapped = u?.legacy ? u : { legacy: { screen_name: u.username || u.screen_name, name: u.name, description: u.description || u.bio || "", followers_count: u.followers_count || u.followersCount }, ...u };
          return normalizeUser(mapped);
        }).filter(Boolean);
      }
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return [];
}

async function discoverFromBinancezhFollowers() {
  if (!RAPIDAPI_KEY) {
    return { ok: false, error: "RAPIDAPI_KEY not configured", added: 0 };
  }
  const db = new Database(DB_PATH);
  const { user } = await getUserByUsername(SOURCE_HANDLE);
  const userId = user?.rest_id || user?.id || loadHandleToIdCache()[SOURCE_HANDLE.toLowerCase()];
  if (!userId) {
    db.close();
    return { ok: false, error: `无法获取 ${SOURCE_HANDLE} 的用户 ID` };
  }
  let followers = await getFollowers(SOURCE_HANDLE, userId);
  if (!followers.length) {
    const getFollowing = async (id) => {
      const TX = process.env.RAPIDAPI_TWITTER_X_HOST || "twitter-x.p.rapidapi.com";
      const h = encodeURIComponent(id);
      const urls = [
        [`https://${TX}/user/following?user_id=${h}`, TX],
        [`https://${RAPIDAPI_FOLLOWING_HOST}/following/${h}`, RAPIDAPI_FOLLOWING_HOST],
        [`https://${RAPIDAPI_FOLLOWING_HOST}/user/following/${h}`, RAPIDAPI_FOLLOWING_HOST],
        [`https://${RAPIDAPI_FOLLOWING_HOST}/get-following?username=${SOURCE_HANDLE}`, RAPIDAPI_FOLLOWING_HOST],
        [`https://${RAPIDAPI_TWITTER_HOST}/following/${h}`, RAPIDAPI_TWITTER_HOST],
        [`https://${RAPIDAPI_TWITTER_HOST}/user/following/${h}`, RAPIDAPI_TWITTER_HOST]
      ];
      for (const [url, host] of urls) {
        try {
          const res = await fetch(url, {
            headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": host }
          });
          if (!res.ok) continue;
          const data = await res.json().catch(() => ({}));
          let users = [];
          const entries = data?.data?.user?.result?.timeline?.timeline?.instructions
            ?.flatMap((i) => i?.entries || (i?.entry ? [i.entry] : []))
            ?.filter((e) => e?.content?.itemContent?.user_results) || [];
          if (entries.length) {
            users = entries.map((e) => e?.content?.itemContent?.user_results?.result).filter(Boolean);
          } else {
            users = data?.data?.users || data?.users || data?.data?.following || data?.following || (Array.isArray(data?.data) ? data.data : []) || [];
          }
          if (users?.length > 0) {
            return users.map((u) => {
              const mapped = u?.legacy ? u : { legacy: { screen_name: u.username || u.screen_name, name: u.name, description: u.description || u.bio || "", followers_count: u.followers_count || u.followersCount }, ...u };
              return normalizeUser(mapped);
            }).filter(Boolean);
          }
        } catch (_e) {}
        await new Promise((r) => setTimeout(r, 200));
      }
      return [];
    };
    followers = await getFollowing(userId);
  }
  if (!followers.length) {
    db.close();
    return { ok: false, error: "API 未返回粉丝/关注列表，请检查 RAPIDAPI 配置或订阅支持 followers/following 的 API", added: 0 };
  }
  const chineseNamed = followers.filter((u) => u && hasChinese(u.name));
  let added = 0;
  const insertKol = db.prepare(
    "INSERT OR IGNORE INTO kols (handle, display_name, twitter_uid, followers, tags, intro, is_lead_trade) VALUES (?, ?, ?, ?, ?, ?, 0)"
  );
  for (const u of chineseNamed) {
    if (!u?.handle) continue;
    const existing = db.prepare("SELECT id FROM kols WHERE lower(handle) = ?").get(u.handle);
    if (existing) continue;
    const displayName = u.name || u.handle;
    const intro = (u.description || "").slice(0, 500);
    const followersCount = Number(u.followersCount) || 0;
    insertKol.run(u.handle, displayName, `@${u.handle}`, followersCount, "binancezh", intro);
    if (db.prepare("SELECT changes()").get()["changes()"] > 0) {
      added++;
    }
  }
  db.close();
  return { ok: true, added, totalFollowers: followers.length, chineseNamed: chineseNamed.length };
}

module.exports = { discoverFromBinancezhFollowers };

if (require.main === module) {
  discoverFromBinancezhFollowers()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
