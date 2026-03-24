/**
 * 从当前 KOL 的关注列表中发现新的 KOL
 * 筛选条件：中文名/中文简介/中文推文 + 币圈/区块链/AI 相关
 * 排除：中文政治博主
 *
 * 运行: node scripts/discover-kols-from-following.js
 * 或通过管理后台 POST /api/admin/discover-from-following (需登录)
 */

require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");

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
const TOPIC_REG =
  /币|链|区块链|btc|eth|crypto|defi|web3|nft|meme|ai|人工智能|智能|投资|交易|空投|挖矿|合约|dex|cex|token|coin|比特|以太|加密|defi|alpha/i;
const POLITICAL_REG =
  /政治|共产党|习近平|民主运动|维权|六四|台独|港独|法轮功|反共|反华|习大大|维尼|独裁|专制|敏感词|墙|翻墙|中共|国政/i;

function hasChinese(s) {
  return s && CN_REG.test(String(s));
}

function isTopicRelevant(s) {
  return s && TOPIC_REG.test(String(s));
}

function isPolitical(s) {
  return s && POLITICAL_REG.test(String(s));
}

const ENABLE_RELAXED = process.env.DISCOVER_RELAXED === "1";
const MIN_FOLLOWERS = Number(process.env.DISCOVER_MIN_FOLLOWERS || 1000);
const TARGET_TOTAL = Number(process.env.DISCOVER_TARGET_TOTAL || 220);
const MAX_USERS_PER_SOURCE = Number(process.env.DISCOVER_MAX_USERS_PER_SOURCE || 80);

function isQualified(user, tweetsText = "") {
  const name = user?.legacy?.name || user?.name || "";
  const desc = user?.legacy?.description || user?.description || "";
  const handle = user?.legacy?.screen_name || user?.screen_name || "";
  const text = `${name} ${desc} ${handle} ${tweetsText}`.toLowerCase();

  if (isPolitical(text)) return false;
  const hasCn = hasChinese(name) || hasChinese(desc) || hasChinese(tweetsText);
  const topicOk = isTopicRelevant(text);
  if (hasCn && topicOk) return true;
  if (ENABLE_RELAXED && topicOk && (hasCn || /crypto|defi|web3|blockchain|btc|eth|nft|ai|以太|比特|链/.test(text))) return true;
  return false;
}

async function fetchRapid(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_TWITTER_HOST,
      ...opts.headers
    },
    ...opts
  });
  return res;
}

async function fetchRapidFollowing(url) {
  return fetch(url, {
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_FOLLOWING_HOST
    }
  });
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

function loadHandleToIdCache() {
  try {
    const rows = dbCache.prepare("SELECT handle, rest_id FROM handle_id_cache").all();
    const out = {};
    for (const r of rows) {
      const h = String(r?.handle || "").toLowerCase();
      const id = String(r?.rest_id || "").trim();
      if (h && id) out[h] = id;
    }
    return out;
  } catch (_e) {
    return {};
  }
}

async function getUserByUsername(handle) {
  const res = await fetchRapid(
    `https://${RAPIDAPI_TWITTER_HOST}/user/by/username/${encodeURIComponent(handle)}`
  );
  const data = await res.json().catch(() => ({}));
  const user = data?.data?.user?.result;
  const rid = user?.rest_id || user?.id;
  if (rid) saveHandleToId(handle, rid);
  return { res, data, user };
}

async function getUserTweets(userId, limit = 20) {
  const url = `https://${RAPIDAPI_TWITTER_X_HOST}/user/tweetsandreplies?user_id=${encodeURIComponent(userId)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_TWITTER_X_HOST
    }
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => ({}));
  let texts = [];
  const arr =
    data?.result?.tweets ||
    data?.result?.replies ||
    data?.tweets ||
    data?.replies ||
    (Array.isArray(data?.result) ? data.result : []);
  if (arr?.length) {
    texts = arr.map((t) => t?.content || t?.text || t?.full_text || t?.body || (typeof t === "string" ? t : ""));
  } else {
    const entries =
      data?.data?.user?.result?.timeline?.timeline?.instructions
        ?.flatMap((i) => i?.entry ? [i.entry] : i?.entries || [])
        ?.filter((e) => e?.content?.itemContent?.tweet_results) || [];
    for (const e of entries) {
      const tr = e?.content?.itemContent?.tweet_results?.result;
      const t = tr?.legacy?.full_text || tr?.note_tweet?.note_tweet_results?.result?.content || tr?.content || "";
      if (t) texts.push(t);
    }
  }
  return texts.filter(Boolean).join(" ");
}

async function getFollowing(handleOrId, usernameHint = "") {
  const h = encodeURIComponent(handleOrId);
  const host = RAPIDAPI_FOLLOWING_HOST;
  const twitterXHost = RAPIDAPI_TWITTER_X_HOST;
  const fetchFollowing = (url, useHost) =>
    fetch(url, {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": useHost || RAPIDAPI_FOLLOWING_HOST
      }
    });

  const tryTwitterX = async () => {
    const url = `https://${twitterXHost}/user/following?user_id=${h}`;
    const res = await fetchFollowing(url, twitterXHost);
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const entries =
      data?.data?.user?.result?.timeline?.timeline?.instructions
        ?.flatMap((i) => i?.entries || (i?.entry ? [i.entry] : []))
        ?.filter((e) => e?.content?.itemContent?.user_results) || [];
    const users = entries
      .map((e) => e?.content?.itemContent?.user_results?.result)
      .filter(Boolean);
    return users.length > 0 ? users : null;
  };

  const r = await tryTwitterX();
  if (r && r.length > 0) return r;

  const endpoints = [
    `https://${host}/following/${h}`,
    `https://${host}/user/following/${h}`,
    `https://${host}/get-following?username=${h}`,
    `https://${host}/friends/list?screen_name=${h}`
  ];
  for (const url of endpoints) {
    try {
      const res = await fetchRapidFollowing(url);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        let users =
          data?.data?.users ||
          data?.users ||
          data?.data?.following ||
          data?.following ||
          (Array.isArray(data?.data) ? data.data : null) ||
          (Array.isArray(data) ? data : []);
        if (users?.length > 0) {
          return users.map((u) => (u?.legacy ? u : { legacy: { screen_name: u.username || u.screen_name, name: u.name, description: u.description || u.bio }, ...u }));
        }
      }
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  // Fallback: use followers endpoint (some providers block following endpoint).
  // We still treat these discovered accounts as social-neighborhood candidates.
  if (RAPIDAPI_FOLLOWERS_HOST && usernameHint) {
    try {
      const url = `https://${RAPIDAPI_FOLLOWERS_HOST}/api/v1/twitter/user/followers?username=${encodeURIComponent(usernameHint)}&count=100`;
      const res = await fetch(url, {
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_FOLLOWERS_HOST
        }
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const users = data?.body || data?.users || data?.followers || [];
        if (Array.isArray(users) && users.length) {
          return users.map((u) =>
            u?.legacy
              ? u
              : {
                  legacy: {
                    screen_name: u.username || u.screen_name,
                    name: u.name,
                    description: u.description || u.bio || "",
                    followers_count: u.followers_count ?? u.followersCount ?? 0
                  },
                  ...u
                }
          );
        }
      }
    } catch (_e) {}
  }
  return [];
}

const MAX_SEED_SOURCES = 3;

async function bootstrapAndDiscoverFromSeed(db, insertKol, seen) {
  let added = 0;
  const cache = loadHandleToIdCache();
  const ids = [...new Set(Object.values(cache))].slice(0, MAX_SEED_SOURCES);
  for (const uid of ids) {
    const following = await getFollowing(uid);
    let count = 0;
    for (const fu of following) {
      if (count >= MAX_USERS_PER_SOURCE) break;
      const u = fu?.result || fu;
      const handle = (u?.legacy?.screen_name || u?.screen_name || u?.username || "").toLowerCase();
      const rid = u?.rest_id || u?.id;
      if (rid && handle) saveHandleToId(handle, rid);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      const existing = db.prepare("SELECT id FROM kols WHERE lower(handle) = ?").get(handle);
      if (existing) continue;
      if (++count > MAX_USERS_PER_SOURCE) break;
      let userForCheck = u;
      if (!u?.legacy?.description) {
        const { user: fullUser } = await getUserByUsername(handle);
        if (fullUser) userForCheck = fullUser;
        await new Promise((r) => setTimeout(r, 350));
      }
      let tweetsText = "";
      if (!hasChinese(userForCheck?.legacy?.name) && !hasChinese(userForCheck?.legacy?.description)) {
        if (rid) {
          tweetsText = await getUserTweets(rid);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      const nameForCheck = userForCheck?.legacy?.name || userForCheck?.name || "";
      const followersForCheck = Number(userForCheck?.legacy?.followers_count ?? userForCheck?.followers_count ?? 0);
      if (!hasChinese(nameForCheck)) continue;
      if (followersForCheck < MIN_FOLLOWERS) continue;
      if (!isQualified(userForCheck, tweetsText)) continue;
      const intro = (userForCheck?.legacy?.description || "").slice(0, 500);
      const name = userForCheck?.legacy?.name || "";
      insertKol.run(handle, name || "", `@${handle}`, followersForCheck, intro || name || "", "discovered");
      added++;
      if (db.prepare("SELECT COUNT(*) AS c FROM kols").get().c >= TARGET_TOTAL) return added;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return added;
}

async function discoverKolsFromFollowing() {
  if (!RAPIDAPI_KEY) {
    return { ok: false, error: "RAPIDAPI_KEY not configured", added: 0, skipped: 0 };
  }
  const db = new Database(DB_PATH);
  const insertKol = db.prepare(
    "INSERT OR IGNORE INTO kols (handle, display_name, twitter_uid, followers, intro, tags) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const seen = new Set();
  let added = 0;
  added += await bootstrapAndDiscoverFromSeed(db, insertKol, seen);

  let skipped = 0;
  const handleToId = loadHandleToIdCache();
  const kols = db.prepare("SELECT id, handle FROM kols").all();
  for (const kol of kols) {
    try {
      const { user } = await getUserByUsername(kol.handle);
      let userId = user?.rest_id || user?.id || handleToId[kol.handle.toLowerCase()];
      if (!userId) userId = handleToId[kol.handle.toLowerCase()];
      if (!userId && /^\d+$/.test(kol.handle)) userId = kol.handle;
      const following = userId ? await getFollowing(userId, kol.handle) : [];
      if (!Array.isArray(following) || following.length === 0) continue;

      for (const fu of following) {
        const u = fu?.result || fu;
        let handle = (u?.legacy?.screen_name || u?.screen_name || u?.username || "").toLowerCase();
        const rid = u?.rest_id || u?.id;
        if (rid && handle) saveHandleToId(handle, rid);
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);

        const existing = db.prepare("SELECT id FROM kols WHERE lower(handle) = ?").get(handle);
        if (existing) {
          skipped++;
          continue;
        }

        let userForCheck = u;
        const { user: fullUser } = await getUserByUsername(handle);
        if (fullUser) userForCheck = fullUser;
        await new Promise((r) => setTimeout(r, 350));

        let tweetsText = "";
        if (!hasChinese(userForCheck?.legacy?.name || userForCheck?.name) && !hasChinese(userForCheck?.legacy?.description || userForCheck?.description)) {
          const uid = fullUser?.rest_id || fullUser?.id || u?.rest_id || u?.id;
          if (uid) {
            tweetsText = await getUserTweets(uid);
            await new Promise((r) => setTimeout(r, 400));
          }
        }

        const nameForCheck = userForCheck?.legacy?.name || userForCheck?.name || "";
        const followersForCheck = Number(userForCheck?.legacy?.followers_count ?? userForCheck?.followers_count ?? 0);
        if (!hasChinese(nameForCheck) || followersForCheck < MIN_FOLLOWERS) {
          skipped++;
          continue;
        }
        if (!isQualified(userForCheck, tweetsText)) {
          skipped++;
          continue;
        }

        const intro = (userForCheck?.legacy?.description || userForCheck?.description || "").slice(0, 500);
        const name = userForCheck?.legacy?.name || userForCheck?.name || "";
        insertKol.run(handle, name || "", `@${handle}`, followersForCheck, intro || name || "", "discovered");
        added++;
        if (db.prepare("SELECT COUNT(*) AS c FROM kols").get().c >= TARGET_TOTAL) break;
      }
      if (db.prepare("SELECT COUNT(*) AS c FROM kols").get().c >= TARGET_TOTAL) break;
    } catch (e) {
      console.warn(`Skip ${kol.handle}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  db.close();
  return { ok: true, added, skipped, totalProcessed: kols.length, minFollowers: MIN_FOLLOWERS, targetTotal: TARGET_TOTAL };
}

module.exports = { discoverKolsFromFollowing, isQualified, hasChinese, isTopicRelevant, isPolitical };

if (require.main === module) {
  discoverKolsFromFollowing()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
