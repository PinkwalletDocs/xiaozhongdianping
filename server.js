const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const multer = require("multer");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");

// 始终从 server.js 所在目录加载 .env（不依赖当前工作目录）
// Vercel：环境变量在控制台配置，不会上传 .env；勿依赖本地文件
const ENV_FILE = path.join(__dirname, ".env");
let dotenvResult = { error: null };
if (!process.env.VERCEL) {
  dotenvResult = dotenv.config({ path: ENV_FILE });
  if (fs.existsSync(ENV_FILE)) {
    let raw = fs.readFileSync(ENV_FILE, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = dotenv.parse(raw);
    [
      "TWITTER_CLIENT_ID",
      "TWITTER_CLIENT_SECRET",
      "BASE_URL",
      "SESSION_SECRET",
      "JWT_SECRET",
      "PORT",
      "ADMIN_TWITTER_HANDLES"
    ].forEach((key) => {
      const v = parsed[key];
      if (v != null && String(v).trim() !== "") process.env[key] = String(v).trim();
    });
  }
}

const TWITTER_CLIENT_ID = (process.env.TWITTER_CLIENT_ID || "").trim();
const TWITTER_CLIENT_SECRET = (process.env.TWITTER_CLIENT_SECRET || "").trim();
const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const MIN_FOLLOWERS_TO_VOTE = 10;

/** 管理员 X 用户名（不含 @），逗号分隔；优先读环境变量，为空时再从 .env 文件解析（避免进程未注入变量时白名单失效） */
function getAdminTwitterHandleSet() {
  let raw = String(process.env.ADMIN_TWITTER_HANDLES || "").trim();
  if (!raw) {
    try {
      if (fs.existsSync(ENV_FILE)) {
        let s = fs.readFileSync(ENV_FILE, "utf8");
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        raw = String(dotenv.parse(s).ADMIN_TWITTER_HANDLES || "").trim();
        if (raw) process.env.ADMIN_TWITTER_HANDLES = raw;
      }
    } catch (_e) {}
  }
  return new Set(
    raw
      .split(/[,;\s|]+/)
      .map((h) => String(h).replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function twitterUsernameFromSession(tw) {
  if (!tw) return "";
  const u = (tw.username || tw.handle || "").replace(/^@/, "").trim().toLowerCase();
  return u;
}

const TW_USER_COOKIE = "tw_user";
const TW_OAUTH_VERIFIER = "tw_oauth_v";
const TW_OAUTH_STATE = "tw_oauth_s";

function cookieBaseOpts() {
  const secure = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure,
    path: "/"
  };
}

function getTwitterUserFromRequest(req) {
  const fromSession = req.session?.twitterUser;
  if (fromSession && typeof fromSession === "object" && fromSession.username != null) return fromSession;
  const raw = req.signedCookies?.[TW_USER_COOKIE];
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = JSON.parse(raw);
    if (u && typeof u.username === "string") return u;
  } catch (_e) {}
  return null;
}

function setTwitterUserCookie(res, user) {
  res.cookie(TW_USER_COOKIE, JSON.stringify(user), {
    ...cookieBaseOpts(),
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearTwitterUserCookie(res) {
  const o = cookieBaseOpts();
  res.clearCookie(TW_USER_COOKIE, { path: o.path, httpOnly: o.httpOnly, sameSite: o.sameSite, secure: o.secure });
}

function clearTwitterOAuthCookies(res) {
  const o = cookieBaseOpts();
  res.clearCookie(TW_OAUTH_VERIFIER, { path: o.path, httpOnly: o.httpOnly, sameSite: o.sameSite, secure: o.secure });
  res.clearCookie(TW_OAUTH_STATE, { path: o.path, httpOnly: o.httpOnly, sameSite: o.sameSite, secure: o.secure });
}

function isTwitterAdminSession(req) {
  const tw = getTwitterUserFromRequest(req);
  const u = twitterUsernameFromSession(tw);
  return Boolean(u && getAdminTwitterHandleSet().has(u));
}

const app = express();
if (process.env.VERCEL || process.env.RENDER) {
  app.set("trust proxy", 1);
}
const PORT = Number(process.env.PORT || 3001);
// Vercel Serverless：项目目录只读，SQLite/上传写到 /tmp（数据不保证持久）
// Render 等：可通过环境变量 DATA_DIR / UPLOAD_DIR 指向持久盘挂载路径（见 render.yaml）
const IS_VERCEL = Boolean(process.env.VERCEL);
function resolveDataDir() {
  if (process.env.DATA_DIR && String(process.env.DATA_DIR).trim()) {
    return path.resolve(String(process.env.DATA_DIR).trim());
  }
  if (IS_VERCEL) return path.join("/tmp", "xiaozhong-data");
  return path.join(__dirname, "data");
}
function resolveUploadDir() {
  if (process.env.UPLOAD_DIR && String(process.env.UPLOAD_DIR).trim()) {
    return path.resolve(String(process.env.UPLOAD_DIR).trim());
  }
  if (IS_VERCEL) return path.join("/tmp", "xiaozhong-uploads");
  return path.join(__dirname, "uploads");
}
const DATA_DIR = resolveDataDir();
const UPLOAD_DIR = resolveUploadDir();
const DB_PATH = path.join(DATA_DIR, "app.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const CHAIN_CONFIG = {
  ethereum: {
    rpc: process.env.ETH_RPC_URL || "",
    usdt: (process.env.ETH_USDT || "0xdAC17F958D2ee523a2206206994597C13D831ec7").toLowerCase()
  },
  arbitrum: {
    rpc: process.env.ARB_RPC_URL || "",
    usdt: (process.env.ARB_USDT || "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9").toLowerCase()
  },
  bsc: {
    rpc: process.env.BSC_RPC_URL || "",
    usdt: (process.env.BSC_USDT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase()
  }
};

const TREASURY_WALLET = (process.env.TREASURY_WALLET || "").toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const COOKIE_SECRET = process.env.SESSION_SECRET || JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD_HASH =
  process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safeName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${file.originalname}`.replace(
        /\s+/g,
        "_"
      );
      cb(null, safeName);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser(COOKIE_SECRET));
app.use(
  session({
    secret: process.env.SESSION_SECRET || JWT_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // HTTPS 生产环境必须 secure，否则浏览器不落登录 Cookie（X 登录后仍显示未登录）
      secure: Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);
app.use("/uploads", express.static(UPLOAD_DIR));

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY,
      vote_count INTEGER DEFAULT 0,
      reputation_weight REAL DEFAULT 1.0,
      is_blacklisted INTEGER DEFAULT 0,
      last_vote_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT UNIQUE NOT NULL,
      display_name TEXT DEFAULT '',
      twitter_uid TEXT,
      avatar_url TEXT DEFAULT '',
      followers INTEGER DEFAULT 0,
      tags TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      is_lead_trade INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      avg_score REAL DEFAULT 0,
      vote_count INTEGER DEFAULT 0,
      risk_index REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      chain TEXT NOT NULL,
      tx_hash TEXT UNIQUE NOT NULL,
      amount_usdt REAL DEFAULT 0,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      kol_id INTEGER NOT NULL,
      biz INTEGER NOT NULL,
      research INTEGER NOT NULL,
      ethics INTEGER NOT NULL,
      reputation INTEGER NOT NULL,
      safety INTEGER NOT NULL,
      comment TEXT DEFAULT '',
      total_score REAL NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wallet, kol_id)
    );

    CREATE TABLE IF NOT EXISTS vote_reactions (
      vote_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      reaction INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (vote_id, wallet)
    );

    CREATE TABLE IF NOT EXISTS vote_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vote_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      kol_id INTEGER NOT NULL,
      biz INTEGER NOT NULL,
      research INTEGER NOT NULL,
      ethics INTEGER NOT NULL,
      reputation INTEGER NOT NULL,
      safety INTEGER NOT NULL,
      comment TEXT DEFAULT '',
      total_score REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS exposes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '',
      twitter_id TEXT NOT NULL,
      event_text TEXT NOT NULL,
      credibility TEXT NOT NULL,
      evidence_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expose_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expose_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expose_reactions (
      expose_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      reaction INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (expose_id, wallet)
    );

    CREATE TABLE IF NOT EXISTS kol_api_cache (
      handle TEXT PRIMARY KEY,
      followers INTEGER DEFAULT 0,
      display_name TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      twitter_uid TEXT DEFAULT '',
      raw_json TEXT DEFAULT '{}',
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kol_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      twitter_link TEXT NOT NULL,
      intro TEXT DEFAULT '',
      tag TEXT DEFAULT '',
      is_lead_trade INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      review_note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try {
    db.exec("ALTER TABLE kols ADD COLUMN avatar_url TEXT DEFAULT ''");
  } catch (_e) {
    // column may already exist
  }
  try {
    db.exec("ALTER TABLE kols ADD COLUMN display_name TEXT DEFAULT ''");
  } catch (_e) {
    // column may already exist
  }
  try {
    db.exec("ALTER TABLE exposes ADD COLUMN title TEXT DEFAULT ''");
  } catch (_e) {
    // column may already exist
  }
  try {
    db.exec("ALTER TABLE exposes ADD COLUMN views INTEGER DEFAULT 0");
  } catch (_e) {
    // column may already exist
  }
}

function seedKols() {
  try {
    const currentCount = Number(db.prepare("SELECT COUNT(*) AS c FROM kols").get()?.c || 0);
    if (currentCount > 0) return;
    const seedPath = path.join(__dirname, "kol-seed.json");
    if (!fs.existsSync(seedPath)) return;
    const raw = fs.readFileSync(seedPath, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return;
    const insert = db.prepare(
      "INSERT OR IGNORE INTO kols (handle, display_name, twitter_uid, followers, tags, intro, is_lead_trade) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = db.transaction((items) => {
      for (const it of items) {
        const handle = String(it?.handle || "")
          .replace(/^@/, "")
          .trim();
        if (!handle) continue;
        const uid = String(it?.uid || `@${handle}`).trim() || `@${handle}`;
        const followers = Math.max(0, Number(it?.followers || 0) || 0);
        const tags = String(it?.tags || "").trim();
        const intro = String(it?.intro || "").trim();
        insert.run(handle, "", uid, followers, tags, intro, Number(it?.is_lead_trade ? 1 : 0));
      }
    });
    tx(arr);
  } catch (_e) {}
}

/** 曾错误地把 handle 写进 display_name，与 X 上「用户名≠id」矛盾，需清空待接口写回真昵称 */
function clearDisplayNameWhenSameAsHandle() {
  try {
    db.prepare(
      `UPDATE kols SET display_name = ''
       WHERE lower(trim(ifnull(display_name,''))) = lower(trim(ifnull(handle,'')))
         AND length(trim(ifnull(handle,''))) > 0`
    ).run();
  } catch (_e) {}
}

/** 仅从 kol_api_cache 补昵称，绝不把 handle 当「用户名」写入 */
function backfillDisplayNames() {
  const rows = db
    .prepare(
      `SELECT k.id, c.display_name AS cd
       FROM kols k
       JOIN kol_api_cache c ON lower(k.handle) = lower(c.handle)
       WHERE (k.display_name IS NULL OR trim(k.display_name) = '')
         AND c.display_name IS NOT NULL AND trim(c.display_name) != ''`
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE kols SET display_name = ? WHERE id = ?");
  const tx = db.transaction((items) => {
    for (const r of items) {
      update.run(String(r.cd).trim(), r.id);
    }
  });
  tx(rows);
}

function backfillFromApiCache() {
  try {
    const rows = db.prepare(
      `SELECT k.id, k.handle, k.followers, k.display_name, k.avatar_url, k.twitter_uid,
              c.followers AS cf, c.display_name AS cd, c.avatar_url AS ca, c.twitter_uid AS cu
       FROM kols k
       JOIN kol_api_cache c ON lower(k.handle) = lower(c.handle)
       WHERE (k.followers = 0 AND c.followers > 0)
          OR (length(trim(ifnull(k.display_name,''))) = 0 AND length(trim(ifnull(c.display_name,''))) > 0)`
    ).all();
    if (!rows.length) return;
    const update = db.prepare("UPDATE kols SET followers = ?, display_name = ?, avatar_url = ?, twitter_uid = ? WHERE id = ?");
    for (const r of rows) {
      const followers = (r.cf != null && r.cf > 0) ? r.cf : r.followers;
      const displayName = (r.cd && String(r.cd).trim()) ? r.cd : (r.display_name || r.handle || "");
      const avatarUrl = (r.ca && String(r.ca).trim()) ? r.ca : (r.avatar_url || "");
      const twitterUid = (r.cu && String(r.cu).trim()) ? r.cu : (r.twitter_uid || "");
      update.run(followers, displayName, avatarUrl, twitterUid, r.id);
    }
  } catch (_e) {}
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    try {
      req.admin = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (_e) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }
  if (isTwitterAdminSession(req)) {
    const tw = getTwitterUserFromRequest(req);
    req.admin = { username: `x:${twitterUsernameFromSession(tw)}`, via: "twitter" };
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

function getUserWeight(voteCount) {
  if (voteCount >= 20) return 1.5;
  if (voteCount >= 5) return 1.2;
  return 1.0;
}

function computeRiskIndex(kolId) {
  const stat = db
    .prepare("SELECT AVG(safety) AS safety_avg, AVG(ethics) AS ethics_avg, COUNT(*) AS c FROM votes WHERE kol_id = ?")
    .get(kolId);
  const exposeCount = db
    .prepare("SELECT COUNT(*) AS c FROM exposes WHERE lower(twitter_id) LIKE '%' || lower((SELECT twitter_uid FROM kols WHERE id = ?)) || '%'")
    .get(kolId).c;
  const safetyPenalty = (6 - (stat.safety_avg || 3)) * 0.6;
  const ethicsPenalty = (6 - (stat.ethics_avg || 3)) * 0.3;
  const exposePenalty = Math.min(exposeCount, 10) * 0.2;
  return Number((safetyPenalty + ethicsPenalty + exposePenalty).toFixed(2));
}

function refreshKolStats(kolId) {
  const agg = db
    .prepare("SELECT SUM(total_score * weight) AS ws, SUM(weight) AS w, COUNT(*) AS c FROM votes WHERE kol_id = ?")
    .get(kolId);
  const avg = agg.w > 0 ? Number((agg.ws / agg.w).toFixed(2)) : 0;
  const risk = computeRiskIndex(kolId);
  db.prepare("UPDATE kols SET avg_score = ?, vote_count = ?, risk_index = ? WHERE id = ?").run(avg, agg.c || 0, risk, kolId);
}

async function verifyDonationTx({ wallet, chain, txHash }) {
  const config = CHAIN_CONFIG[chain];
  if (!config || !config.rpc || !config.usdt || !TREASURY_WALLET) {
    throw new Error("Donation verification config missing");
  }
  const provider = new ethers.JsonRpcProvider(config.rpc);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) throw new Error("Transaction not found or failed");
  const iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  let amount = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.usdt) continue;
    try {
      const parsed = iface.parseLog(log);
      const from = String(parsed.args.from).toLowerCase();
      const to = String(parsed.args.to).toLowerCase();
      if (from === wallet.toLowerCase() && to === TREASURY_WALLET) {
        amount += Number(parsed.args.value) / 1e6;
      }
    } catch (_e) {
      // ignore unrelated logs
    }
  }
  if (amount < 1) throw new Error("USDT transfer to treasury below 1U");
  return Number(amount.toFixed(4));
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_TWITTER_HOST = process.env.RAPIDAPI_TWITTER_HOST || "twittr-v2-fastest-twitter-x-api-150k-requests-for-15.p.rapidapi.com";
/** 与主 API 不同产品时，用同一 RapidAPI Key 拉用户资料（如 twitter-social 的 profile） */
const RAPIDAPI_FOLLOWERS_HOST = (process.env.RAPIDAPI_FOLLOWERS_HOST || "").trim();

/** 深度查找 pbs.twimg.com 头像（兼容各种嵌套字段名） */
function findTwimgProfileUrlInObject(obj, depth = 0) {
  if (!obj || depth > 14) return "";
  if (typeof obj === "string") {
    return /pbs\.twimg\.com\/profile_images/i.test(obj) ? obj : "";
  }
  if (typeof obj !== "object") return "";
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.startsWith("http") && /profile|avatar|image/i.test(k)) {
      if (/pbs\.twimg\.com\/profile_images/i.test(v)) return v;
    }
    const inner = findTwimgProfileUrlInObject(v, depth + 1);
    if (inner) return inner;
  }
  return "";
}

function normalizeTwitterAvatarUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url
    .trim()
    .replace(/_normal(\.[a-z]+)?(\?|$)/i, "_400x400$1$2")
    .replace(/_bigger(\.[a-z]+)?(\?|$)/i, "_400x400$1$2")
    .replace(/_mini(\.[a-z]+)?(\?|$)/i, "_400x400$1$2");
}

/**
 * 从 Rapid 上各类 Twitter/X API 的 JSON 里抽出头像与昵称（不假设固定路径）
 */
function parseTwitterProfileFromRapidApiJson(data, targetHandle = "") {
  if (!data || typeof data !== "object") return null;

  const fromNode = (u) => {
    if (!u || typeof u !== "object") return null;
    const legacy = u.legacy && typeof u.legacy === "object" ? u.legacy : {};
    const avatarRaw =
      u?.avatar?.image_url ||
      legacy.profile_image_url_https ||
      u.profile_image_url_https ||
      u.profile_image_url ||
      u.profileImageUrl ||
      u.profile_image ||
      u.image_url_https ||
      u.image_url ||
      "";
    const screenName = (
      u?.core?.screen_name ||
      legacy.screen_name ||
      u.username ||
      u.screen_name ||
      u.screenName ||
      ""
    )
      .toString()
      .replace(/^@/, "")
      .trim();
    const displayName = (
      u?.core?.name ||
      legacy.name ||
      u.name ||
      u.displayName ||
      u.display_name ||
      u.fullname ||
      u.fullName ||
      u.global_name ||
      ""
    )
      .toString()
      .trim();
    const followers =
      Number(
        legacy.followers_count ??
          u?.public_metrics?.followers_count ??
          u?.followers_count ??
          u?.followersCount ??
          0
      ) || 0;
    const avatarNorm = normalizeTwitterAvatarUrl(avatarRaw);
    if (!avatarNorm && !screenName && !displayName) return null;
    return {
      avatarUrl: avatarNorm,
      displayName,
      screenName,
      followersNum: followers,
      userNode: u
    };
  };

  const candidates = [
    data?.data?.user?.result,
    data?.data?.user,
    data?.data?.result,
    data?.result?.data?.user?.result,
    data?.result?.user,
    data?.result,
    data?.user,
    data?.body,
    data?.data?.users?.[0],
    data?.users?.[0],
    Array.isArray(data?.data) ? data.data[0] : null,
    typeof data?.data === "object" && data?.data && !data?.data?.user ? data.data : null
  ];

  for (const node of candidates) {
    const p = fromNode(node);
    if (p?.avatarUrl) return p;
  }
  for (const node of candidates) {
    const p = fromNode(node);
    if (p?.screenName) return p;
  }

  const deep = findTwimgProfileUrlInObject(data);
  if (deep) {
    let displayName = "";
    let screenName = "";
    for (const node of candidates) {
      const p = fromNode(node);
      if (!p) continue;
      if (p.displayName) displayName = p.displayName;
      if (p.screenName) screenName = p.screenName;
      if (displayName && screenName) break;
    }
    return {
      avatarUrl: normalizeTwitterAvatarUrl(deep),
      displayName,
      screenName,
      followersNum: 0,
      userNode: null
    };
  }

  // Final fallback: deep scan by exact handle to recover display name/avatar
  const target = String(targetHandle || "")
    .toLowerCase()
    .replace(/^@/, "")
    .trim();
  if (target) {
    const visit = (node, depth = 0) => {
      if (!node || depth > 16 || typeof node !== "object") return null;
      const screen = String(
        node?.screen_name || node?.screenName || node?.username || node?.handle || node?.user_name || ""
      )
        .toLowerCase()
        .replace(/^@/, "")
        .trim();
      const legacy = node?.legacy && typeof node.legacy === "object" ? node.legacy : {};
      const legacyScreen = String(legacy?.screen_name || "").toLowerCase().replace(/^@/, "").trim();
      const match = screen === target || legacyScreen === target;
      if (match) {
        const name =
          String(
            node?.name ||
              node?.display_name ||
              node?.displayName ||
              node?.full_name ||
              node?.fullName ||
              legacy?.name ||
              ""
          ).trim() || "";
        const avatarRaw =
          node?.avatar?.image_url ||
          node?.profile_image_url_https ||
          node?.profile_image_url ||
          legacy?.profile_image_url_https ||
          "";
        return {
          avatarUrl: normalizeTwitterAvatarUrl(avatarRaw),
          displayName: name,
          screenName: target,
          followersNum:
            Number(
              node?.followers_count ??
                node?.followersCount ??
                node?.public_metrics?.followers_count ??
                legacy?.followers_count ??
                0
            ) || 0,
          userNode: node
        };
      }
      for (const v of Object.values(node)) {
        const got = visit(v, depth + 1);
        if (got) return got;
      }
      return null;
    };
    const byHandle = visit(data);
    if (byHandle) return byHandle;
  }

  return null;
}

/**
 * 先打主 Twitter API，再用 twitter-social profile 合并昵称/头像（同一 Key 需分别订阅）
 */
async function fetchRapidApiUserProfileMerged(handleLc) {
  const h = String(handleLc || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!RAPIDAPI_KEY || !h) return { res: null, data: {}, profile: null, uGraph: null };

  const headers = (host) => ({
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": host
  });

  const fetchOne = async (url, host) => {
    const res = await fetch(url, { headers: headers(host) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const primaryUrl = `https://${RAPIDAPI_TWITTER_HOST}/user/by/username/${encodeURIComponent(h)}`;
  const first = await fetchOne(primaryUrl, RAPIDAPI_TWITTER_HOST);
  let res = first.res;
  let data = first.data;
  const uGraphPrimary = first.data?.data?.user?.result;
  let profile = parseTwitterProfileFromRapidApiJson(first.data, h);

  if (RAPIDAPI_FOLLOWERS_HOST) {
    try {
      const altUrl = `https://${RAPIDAPI_FOLLOWERS_HOST}/api/v1/twitter/user/profile?username=${encodeURIComponent(h)}`;
      const second = await fetchOne(altUrl, RAPIDAPI_FOLLOWERS_HOST);
      const p2 = parseTwitterProfileFromRapidApiJson(second.data, h);
      if (p2) {
        profile = {
          avatarUrl: (p2.avatarUrl || profile?.avatarUrl || "").trim(),
          displayName: (p2.displayName || profile?.displayName || "").trim(),
          screenName: (p2.screenName || profile?.screenName || "").trim(),
          followersNum: Math.max(p2.followersNum || 0, profile?.followersNum || 0),
          userNode: p2.userNode || profile?.userNode
        };
        if (p2.avatarUrl || p2.displayName || p2.screenName) {
          res = second.res;
          data = second.data;
        }
      }
    } catch (_e) {}
  }

  return { res, data, profile, uGraph: uGraphPrimary };
}

function isUserNonExistent(res, data, u) {
  if (!res.ok && res.status === 404) return true;
  // Do not treat empty payloads (e.g. 429 quota/network errors) as "user not found".
  if (!u) return false;
  const t = u?.__typename || "";
  if (/UserUnavailable|UserTakedown|UserSoftUnavailable/i.test(t)) return true;
  if (
    data?.errors?.some((e) =>
      /not found|does not exist|suspended|unavailable/i.test(e?.message || "")
    ) &&
    res?.status === 404
  ) {
    return true;
  }
  return false;
}

/** Normalize x.com / twitter.com URL or @handle to lowercase screen name */
function extractTwitterHandleFromSubjectId(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  try {
    s = s.normalize("NFKC");
  } catch (_e) {}
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  // 全角冒号、斜杠（从微信等粘贴常见）
  s = s.replace(/\uFF1A/g, ":").replace(/\uFF0F/g, "/");
  const hostPath = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,30})(?=[^A-Za-z0-9_]|$)/i;
  let urlMatch = s.match(hostPath);
  if (urlMatch) return urlMatch[1].toLowerCase();
  urlMatch = s.match(/(?:^|[^\w])(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,30})(?=[^A-Za-z0-9_]|$)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  const cleaned = s.replace(/^@/, "").trim();
  const tail = cleaned.split("/").filter(Boolean).pop() || cleaned;
  const handleOnly = tail.split("?")[0].split("#")[0].split(":")[0];
  if (/^[A-Za-z0-9_]{1,30}$/.test(handleOnly)) return handleOnly.toLowerCase();
  return "";
}

async function refreshSingleKolFromTwitter(kol) {
  if (!RAPIDAPI_KEY || !kol?.id || !kol?.handle) return;
  const updateFollowers = db.prepare("UPDATE kols SET followers = ? WHERE id = ?");
  const updateAvatar = db.prepare("UPDATE kols SET avatar_url = ? WHERE id = ?");
  const updateDisplayName = db.prepare("UPDATE kols SET display_name = ? WHERE id = ?");
  const updateTwitterUid = db.prepare("UPDATE kols SET twitter_uid = ? WHERE id = ?");
  const deleteVotes = db.prepare("DELETE FROM votes WHERE kol_id = ?");
  const deleteVoteHistory = db.prepare("DELETE FROM vote_history WHERE kol_id = ?");
  const deleteKol = db.prepare("DELETE FROM kols WHERE id = ?");
  try {
    const { res, data, profile, uGraph } = await fetchRapidApiUserProfileMerged(kol.handle);
    if (!res) return;
    if (!res.ok && res.status !== 404 && !profile?.avatarUrl && !profile?.displayName && !profile?.screenName) return;
    if (isUserNonExistent(res, data, uGraph)) {
      db.transaction(() => {
        deleteVoteHistory.run(kol.id);
        deleteVotes.run(kol.id);
        deleteKol.run(kol.id);
      })();
      return;
    }
    if (!profile) return;
    const avatarUrl = profile.avatarUrl || "";
    const displayName = profile.displayName || "";
    const screenName = profile.screenName || "";
    const followersNum = profile.followersNum;
    if (!Number.isNaN(followersNum)) updateFollowers.run(followersNum, kol.id);
    if (avatarUrl) updateAvatar.run(avatarUrl, kol.id);
    if (displayName) updateDisplayName.run(displayName, kol.id);
    if (screenName) updateTwitterUid.run(`@${screenName}`, kol.id);
    try {
      const safeFollowers = Number.isNaN(followersNum) ? 0 : followersNum;
      upsertKolApiCache(
        kol.handle,
        safeFollowers,
        displayName,
        avatarUrl,
        screenName ? `@${screenName}` : "",
        JSON.stringify(data)
      );
    } catch (_e) {}
  } catch (_e) {
    // skip on error (network etc.), do not delete
  }
}

async function syncTwitterFollowers() {
  if (!RAPIDAPI_KEY) return;
  const kols = db.prepare("SELECT id, handle FROM kols").all();
  for (const kol of kols) {
    await refreshSingleKolFromTwitter(kol);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Avatar URL from DB (kols first, then kol_api_cache); case-insensitive handle */
function getStoredAvatarUrl(handleNorm) {
  const h = String(handleNorm || "").toLowerCase().replace(/^@/, "");
  if (!h) return "";
  const rowK = db.prepare("SELECT avatar_url FROM kols WHERE lower(handle) = ?").get(h);
  if (rowK?.avatar_url && String(rowK.avatar_url).trim()) return String(rowK.avatar_url).trim();
  const rowC = db.prepare("SELECT avatar_url FROM kol_api_cache WHERE lower(handle) = ?").get(h);
  if (rowC?.avatar_url && String(rowC.avatar_url).trim()) return String(rowC.avatar_url).trim();
  return "";
}

/**
 * 合并写入 kol_api_cache：新请求里缺的字段保留库里旧值，避免「只解析到头像却把昵称冲成空」
 */
function upsertKolApiCache(handleLc, followersNum, displayNameIn, avatarUrlIn, twitterUidIn, rawJsonStr) {
  const h = String(handleLc || "").toLowerCase().replace(/^@/, "");
  if (!h) return;
  const ex = db.prepare("SELECT followers, display_name, avatar_url, twitter_uid FROM kol_api_cache WHERE lower(handle) = ?").get(h);
  const display_name = String(displayNameIn || "").trim() || String(ex?.display_name || "").trim() || "";
  const avatar_url = String(avatarUrlIn || "").trim() || String(ex?.avatar_url || "").trim() || "";
  const twitter_uid = String(twitterUidIn || "").trim() || String(ex?.twitter_uid || "").trim() || "";
  let followers = Number(followersNum);
  if (Number.isNaN(followers)) followers = Number(ex?.followers) || 0;
  const raw = rawJsonStr != null ? String(rawJsonStr) : "{}";
  db.prepare(
    `INSERT OR REPLACE INTO kol_api_cache (handle, followers, display_name, avatar_url, twitter_uid, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(h, followers, display_name, avatar_url, twitter_uid, raw);
}

/** On-demand profile fetch for avatar (爆料主角等不在 kols 时)；同 handle 并发只打一次 RapidAPI */
const pendingAvatarProfileFetch = new Map();

async function fetchProfileForAvatarCache(handleNorm) {
  if (!RAPIDAPI_KEY || !handleNorm) return "";
  const h = String(handleNorm).toLowerCase().replace(/^@/, "");
  if (!h) return "";

  const inflight = pendingAvatarProfileFetch.get(h);
  if (inflight) {
    await inflight;
    return getStoredAvatarUrl(h);
  }

  let task;
  task = (async () => {
    try {
      const { res, data, profile, uGraph } = await fetchRapidApiUserProfileMerged(h);
      if (!res) return;
      if (isUserNonExistent(res, data, uGraph)) return;
      if (!profile || (!profile.avatarUrl && !profile.displayName && !profile.screenName)) {
        if (!res.ok && res.status !== 404) return;
        return;
      }
      const avatarUrl = profile.avatarUrl || "";
      const displayName = profile.displayName || "";
      const screenName = profile.screenName || "";
      const followersNum = profile.followersNum;
      const safeFollowers = Number.isNaN(followersNum) ? 0 : followersNum;
      try {
        upsertKolApiCache(h, safeFollowers, displayName, avatarUrl, screenName ? `@${screenName}` : "", JSON.stringify(data));
      } catch (_e) {}
      const kol = db.prepare("SELECT id FROM kols WHERE lower(handle) = ?").get(h);
      if (kol) {
        if (avatarUrl) db.prepare("UPDATE kols SET avatar_url = ? WHERE id = ?").run(avatarUrl, kol.id);
        if (displayName) db.prepare("UPDATE kols SET display_name = ? WHERE id = ?").run(displayName, kol.id);
        if (screenName) db.prepare("UPDATE kols SET twitter_uid = ? WHERE id = ?").run(`@${screenName}`, kol.id);
        if (!Number.isNaN(followersNum)) db.prepare("UPDATE kols SET followers = ? WHERE id = ?").run(safeFollowers, kol.id);
      }
    } catch (_e) {
      /* ignore */
    } finally {
      if (pendingAvatarProfileFetch.get(h) === task) pendingAvatarProfileFetch.delete(h);
    }
  })();

  pendingAvatarProfileFetch.set(h, task);
  await task;
  return getStoredAvatarUrl(h);
}

function readSyncMeta() {
  try {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'sync_meta'").get();
    return row?.value ? JSON.parse(row.value) : {};
  } catch (_e) {
    return {};
  }
}

function writeSyncMeta(meta) {
  try {
    db.prepare(
      "INSERT INTO app_meta (key, value, updated_at) VALUES ('sync_meta', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).run(JSON.stringify(meta || {}));
  } catch (_e) {
    // ignore metadata write errors
  }
}

async function runWeeklyFollowerSyncIfDue() {
  if (!RAPIDAPI_KEY) return;
  const meta = readSyncMeta();
  const lastAt = Number(meta.followersSyncAt || 0);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (now - lastAt < weekMs) return;
  await syncTwitterFollowers();
  writeSyncMeta({ ...meta, followersSyncAt: now });
}

initDb();
seedKols();
clearDisplayNameWhenSameAsHandle();
backfillDisplayNames();
backfillFromApiCache();
if (RAPIDAPI_KEY) {
  setTimeout(() => runWeeklyFollowerSyncIfDue().catch(() => {}), 3000);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    pid: process.pid,
    twitterOAuthConfigured: Boolean(TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET),
    serverRoot: __dirname,
    vercel: Boolean(process.env.VERCEL),
    dataDir: DATA_DIR,
    uploadDir: UPLOAD_DIR
  });
});

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

app.get("/api/auth/twitter", (req, res) => {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    return res.status(503).json({ error: "Twitter login not configured" });
  }
  const verifier = generateCodeVerifier();
  const o = cookieBaseOpts();
  res.cookie(TW_OAUTH_VERIFIER, verifier, { ...o, maxAge: 10 * 60 * 1000 });
  const challenge = base64url(sha256(Buffer.from(verifier)));
  const redirectUri = `${BASE_URL.replace(/\/$/, "")}/api/auth/twitter/callback`;
  const scope = "tweet.read users.read offline.access";
  const state = crypto.randomBytes(16).toString("base64url");
  res.cookie(TW_OAUTH_STATE, state, { ...o, maxAge: 10 * 60 * 1000 });
  const url = `https://x.com/i/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(TWITTER_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  res.redirect(url);
});

app.get("/api/auth/twitter/callback", async (req, res) => {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    return res.redirect("/#kol");
  }
  const { code, state } = req.query || {};
  const storedState = req.signedCookies?.[TW_OAUTH_STATE];
  const verifier = req.signedCookies?.[TW_OAUTH_VERIFIER];
  if (!code || !state || state !== storedState || !verifier) {
    clearTwitterOAuthCookies(res);
    return res.redirect("/#kol");
  }
  clearTwitterOAuthCookies(res);

  const redirectUri = `${BASE_URL.replace(/\/$/, "")}/api/auth/twitter/callback`;
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  let tokenRes;
  try {
    tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString("base64")}`
      },
      body: body.toString()
    });
  } catch (e) {
    return res.redirect("/#kol");
  }
  if (!tokenRes.ok) {
    return res.redirect("/#kol");
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) return res.redirect("/#kol");

  let userRes;
  try {
    userRes = await fetch("https://api.twitter.com/2/users/me?user.fields=username,name,profile_image_url,public_metrics", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (e) {
    return res.redirect("/#kol");
  }
  if (!userRes.ok) return res.redirect("/#kol");
  const userData = await userRes.json();
  const u = userData.data;
  if (!u) return res.redirect("/#kol");

  const handle = String(u.username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  const followers = Number(u?.public_metrics?.followers_count ?? 0);

  const twitterUser = {
    handle: handle ? `@${handle}` : "",
    username: handle,
    name: u.name || handle,
    profileImageUrl: u.profile_image_url || "",
    followers
  };
  setTwitterUserCookie(res, twitterUser);
  res.redirect("/#kol");
});

app.get("/api/auth/me", (req, res) => {
  const user = getTwitterUserFromRequest(req);
  if (!user) return res.json({ loggedIn: false });
  const isAdmin = isTwitterAdminSession(req);
  const followersNum = Number(user.followers) || 0;
  const canVote = Boolean(isAdmin || followersNum >= MIN_FOLLOWERS_TO_VOTE);
  res.json({
    loggedIn: true,
    handle: user.handle,
    username: user.username,
    name: user.name,
    profileImageUrl: user.profileImageUrl,
    followers: followersNum,
    canVote,
    isAdmin: Boolean(isAdmin)
  });
});

app.post("/api/auth/logout", (req, res) => {
  clearTwitterUserCookie(res);
  if (req.session) {
    delete req.session.twitterUser;
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  } else {
    res.json({ ok: true });
  }
});

app.get("/api/avatar/:handle", async (req, res) => {
  const raw = decodeURIComponent(req.params.handle || "").trim().replace(/^@/, "");
  const handleKey = raw.toLowerCase();
  const displayHandle = raw || handleKey;

  let imageUrl = getStoredAvatarUrl(handleKey);
  if (!imageUrl && RAPIDAPI_KEY) {
    imageUrl = await fetchProfileForAvatarCache(handleKey);
  }

  const imgFetchOpts = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: "https://x.com/"
    }
  };

  const serveFallback = async () => {
    const unavatarUrls = [
      `https://unavatar.io/x/${encodeURIComponent(handleKey)}`,
      `https://unavatar.io/twitter/${encodeURIComponent(handleKey)}`
    ];
    for (const ua of unavatarUrls) {
      try {
        const uaRes = await fetch(ua, {
          redirect: "follow",
          headers: { "User-Agent": imgFetchOpts.headers["User-Agent"] }
        });
        if (uaRes.ok) {
          const ct = (uaRes.headers.get("content-type") || "").toLowerCase();
          if (ct.includes("image")) {
            const buf = await uaRes.arrayBuffer();
            res.set("Cache-Control", "public, max-age=3600");
            res.set("Content-Type", uaRes.headers.get("content-type") || "image/png");
            return res.send(Buffer.from(buf));
          }
        }
      } catch (_e) {}
    }

    try {
      const fallbackRes = await fetch(
        `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(handleKey)}`
      );
      if (fallbackRes.ok) {
        const buf = await fallbackRes.arrayBuffer();
        res.set("Cache-Control", "public, max-age=86400");
        res.set("Content-Type", fallbackRes.headers.get("content-type") || "image/svg+xml");
        return res.send(Buffer.from(buf));
      }
    } catch (_e) {}
    const hue = (displayHandle.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 360);
    const letter = String(displayHandle.charAt(0) || "?")
      .toUpperCase()
      .replace(/[<&"]/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="hsl(${hue},60%,45%)"/><text x="50" y="62" text-anchor="middle" fill="white" font-size="40" font-family="sans-serif">${letter}</text></svg>`;
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Type", "image/svg+xml");
    res.send(svg);
  };

  if (!imageUrl) return serveFallback();

  try {
    const imgRes = await fetch(imageUrl, imgFetchOpts);
    if (!imgRes.ok) return serveFallback();
    const buf = await imgRes.arrayBuffer();
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
    return res.send(Buffer.from(buf));
  } catch (_e) {
    return serveFallback();
  }
});

app.get("/api/kols", async (req, res) => {
  const rank = req.query.rank || "top";
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const qLike = `%${q}%`;
  const base = `
    SELECT id, handle, display_name, twitter_uid, avatar_url, followers, tags, intro, is_lead_trade, avg_score, vote_count, risk_index, created_at
    FROM kols
    WHERE (lower(handle) LIKE ? OR lower(display_name) LIKE ? OR lower(twitter_uid) LIKE ?)
  `;
  let orderBy = "ORDER BY followers DESC, avg_score DESC, vote_count DESC";
  if (rank === "black") orderBy = "ORDER BY risk_index DESC, avg_score ASC";
  if (rank === "new") orderBy = "ORDER BY avg_score DESC, followers DESC, vote_count DESC";
  if (rank === "all") orderBy = "ORDER BY followers DESC, avg_score DESC, vote_count DESC";
  let rows = db.prepare(`${base} ${orderBy}`).all(qLike, qLike, qLike);
  // On-demand fill missing display_name/avatar from RapidAPI (small capped batch)
  if (RAPIDAPI_KEY) {
    const missing = rows
      .filter((r) => (!String(r.display_name || "").trim() || !String(r.avatar_url || "").trim()) && String(r.handle || "").trim())
      .map((r) => String(r.handle || "").trim().toLowerCase());
    const uniq = Array.from(new Set(missing)).slice(0, 10);
    for (const h of uniq) {
      try {
        await fetchProfileForAvatarCache(h);
      } catch (_e) {}
    }
    if (uniq.length) {
      rows = db.prepare(`${base} ${orderBy}`).all(qLike, qLike, qLike);
    }
  }
  const pinned = rows.find((r) => r.handle === "xlink_lab");
  if (pinned) {
    rows = [pinned, ...rows.filter((r) => r.handle !== "xlink_lab")];
  }
  res.json(rows);
});

app.get("/api/kols/:handle/votes", async (req, res) => {
  const handle = req.params.handle;
  const kol = db.prepare("SELECT id FROM kols WHERE handle = ?").get(handle);
  if (!kol) return res.status(404).json({ error: "KOL not found" });
  const rows = db
    .prepare(
      `SELECT v.id, v.wallet, v.comment, v.total_score, v.biz, v.research, v.ethics, v.reputation, v.safety, v.created_at
       FROM votes v WHERE v.kol_id = ? ORDER BY v.created_at DESC`
    )
    .all(kol.id);
  const voteIds = rows.map((r) => r.id);
  const likeCounts = {};
  const dislikeCounts = {};
  const myReactions = {};
  const tw = getTwitterUserFromRequest(req);
  const myWallet = tw ? `twitter:${(tw.username || tw.handle?.replace(/^@/, "") || "").toLowerCase()}` : null;

  if (voteIds.length) {
    const placeholders = voteIds.map(() => "?").join(",");
    db.prepare(`SELECT vote_id, wallet, reaction FROM vote_reactions WHERE vote_id IN (${placeholders})`).all(...voteIds).forEach((r) => {
      if (r.reaction === 1) likeCounts[r.vote_id] = (likeCounts[r.vote_id] || 0) + 1;
      else if (r.reaction === -1) dislikeCounts[r.vote_id] = (dislikeCounts[r.vote_id] || 0) + 1;
      if (r.wallet === myWallet) myReactions[r.vote_id] = r.reaction;
    });
  }

  const repliesByVote = {};
  if (voteIds.length) {
    const ph = voteIds.map(() => "?").join(",");
    db.prepare(`SELECT id, vote_id, wallet, content, created_at FROM vote_replies WHERE vote_id IN (${ph}) ORDER BY created_at ASC`)
      .all(...voteIds)
      .forEach((r) => {
        if (!repliesByVote[r.vote_id]) repliesByVote[r.vote_id] = [];
        repliesByVote[r.vote_id].push(r);
      });
  }

  // Attach author display_name (username) for main vote + replies
  const getNameK = db.prepare("SELECT display_name FROM kols WHERE lower(handle) = ?");
  const getNameC = db.prepare("SELECT display_name FROM kol_api_cache WHERE lower(handle) = ?");
  const getName = (h) => {
    const nameK = String(getNameK.get(h)?.display_name || "").trim();
    if (nameK) return nameK;
    const nameC = String(getNameC.get(h)?.display_name || "").trim();
    return nameC;
  };

  const needFetch = new Set();
  const mainHandles = rows
    .map((v) => String(v.wallet || "").replace(/^twitter:/i, "").toLowerCase())
    .filter(Boolean);
  mainHandles.forEach((h) => {
    if (!getName(h)) needFetch.add(h);
  });
  Object.values(repliesByVote).flat().forEach((r) => {
    const h = String(r?.wallet || "").replace(/^twitter:/i, "").toLowerCase();
    if (!h) return;
    if (!getName(h)) needFetch.add(h);
  });

  if (RAPIDAPI_KEY && needFetch.size) {
    const uniq = Array.from(needFetch).slice(0, 10);
    for (const h of uniq) {
      try {
        await fetchProfileForAvatarCache(h);
      } catch (_e) {}
    }
  }

  const list = rows.map((v) => {
    const mainHandle = String(v.wallet || "").replace(/^twitter:/i, "").toLowerCase();
    const authorHandleDisp = mainHandle ? `@${mainHandle}` : "匿名";
    const authorName = getName(mainHandle) || authorHandleDisp;
    const replies = (repliesByVote[v.id] || []).map((r) => {
      const h = String(r?.wallet || "").replace(/^twitter:/i, "").toLowerCase();
      const handleDisp = h ? `@${h}` : "匿名";
      const authorNameR = getName(h) || handleDisp;
      return { ...r, author_name: authorNameR, author_handle: handleDisp };
    });
    return {
      id: v.id,
      wallet: v.wallet,
      author: authorHandleDisp,
      author_name: authorName,
      comment: v.comment,
      totalScore: v.total_score,
      biz: v.biz,
      research: v.research,
      ethics: v.ethics,
      reputation: v.reputation,
      safety: v.safety,
      createdAt: v.created_at,
      likes: likeCounts[v.id] || 0,
      dislikes: dislikeCounts[v.id] || 0,
      myReaction: myReactions[v.id] ?? null,
      replies
    };
  });

  res.json({ total: list.length, list });
});

app.post("/api/votes/:id/react", (req, res) => {
  const voteId = Number(req.params.id);
  const { reaction } = req.body || {};
  const tw = getTwitterUserFromRequest(req);
  if (!tw) return res.status(401).json({ error: "请先登录 X（推特）" });
  const wallet = `twitter:${(tw.username || tw.handle?.replace(/^@/, "") || "").toLowerCase()}`;
  const r = Number(reaction);
  if (r !== 1 && r !== -1) return res.status(400).json({ error: "reaction must be 1 or -1" });
  const vote = db.prepare("SELECT id FROM votes WHERE id = ?").get(voteId);
  if (!vote) return res.status(404).json({ error: "Vote not found" });

  const existing = db.prepare("SELECT reaction FROM vote_reactions WHERE vote_id = ? AND wallet = ?").get(voteId, wallet);
  if (existing) {
    if (existing.reaction === r) {
      db.prepare("DELETE FROM vote_reactions WHERE vote_id = ? AND wallet = ?").run(voteId, wallet);
      return res.json({ ok: true, reaction: null });
    }
    db.prepare("UPDATE vote_reactions SET reaction = ?, created_at = datetime('now') WHERE vote_id = ? AND wallet = ?").run(r, voteId, wallet);
  } else {
    db.prepare("INSERT INTO vote_reactions (vote_id, wallet, reaction) VALUES (?, ?, ?)").run(voteId, wallet, r);
  }
  const likes = db.prepare("SELECT COUNT(*) AS c FROM vote_reactions WHERE vote_id = ? AND reaction = 1").get(voteId).c;
  const dislikes = db.prepare("SELECT COUNT(*) AS c FROM vote_reactions WHERE vote_id = ? AND reaction = -1").get(voteId).c;
  res.json({ ok: true, reaction: r, likes, dislikes });
});

app.post("/api/votes/:id/replies", (req, res) => {
  const voteId = Number(req.params.id);
  const { content } = req.body || {};
  const tw = getTwitterUserFromRequest(req);
  if (!tw) return res.status(401).json({ error: "请先登录 X（推特）" });
  const wallet = `twitter:${(tw.username || tw.handle?.replace(/^@/, "") || "").toLowerCase()}`;
  const text = (content || "").toString().trim();
  if (!text) return res.status(400).json({ error: "content is required" });
  const vote = db.prepare("SELECT id FROM votes WHERE id = ?").get(voteId);
  if (!vote) return res.status(404).json({ error: "Vote not found" });

  db.prepare("INSERT INTO vote_replies (vote_id, wallet, content) VALUES (?, ?, ?)").run(voteId, wallet, text);
  const row = db.prepare("SELECT id, vote_id, wallet, content, created_at FROM vote_replies WHERE id = last_insert_rowid()").get();
  res.json({ ok: true, reply: row });
});

app.post("/api/donations/verify", async (req, res) => {
  try {
    const { wallet, chain, txHash } = req.body || {};
    if (!wallet || !chain || !txHash) return res.status(400).json({ error: "wallet, chain, txHash are required" });
    const existed = db.prepare("SELECT * FROM donations WHERE tx_hash = ?").get(txHash);
    if (existed?.verified) return res.json({ ok: true, reused: true, amount: existed.amount_usdt });
    const amount = await verifyDonationTx({ wallet, chain, txHash });
    db.prepare("INSERT OR REPLACE INTO donations (wallet, chain, tx_hash, amount_usdt, verified) VALUES (?, ?, ?, ?, 1)").run(
      wallet.toLowerCase(),
      chain,
      txHash,
      amount
    );
    res.json({ ok: true, amount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/users/:wallet/eligibility", (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  const donation = db
    .prepare("SELECT id, amount_usdt, created_at FROM donations WHERE wallet = ? AND verified = 1 ORDER BY id DESC LIMIT 1")
    .get(wallet);
  const user = db.prepare("SELECT * FROM users WHERE wallet = ?").get(wallet);
  res.json({
    wallet,
    donated: Boolean(donation),
    donation: donation || null,
    blacklisted: Boolean(user?.is_blacklisted)
  });
});

app.post("/api/votes", (req, res) => {
  const { kolHandle, comment = "", scores = {} } = req.body || {};
  const tw = getTwitterUserFromRequest(req);
  if (!tw) return res.status(401).json({ error: "请先登录 X（推特）" });
  const isAdmin = isTwitterAdminSession(req);
  if (!isAdmin && tw.followers < MIN_FOLLOWERS_TO_VOTE) {
    return res.status(403).json({ error: `粉丝数至少 ${MIN_FOLLOWERS_TO_VOTE} 才能投票，当前：${tw.followers}` });
  }
  if (!kolHandle) return res.status(400).json({ error: "kolHandle is required" });
  const walletLc = `twitter:${tw.username || tw.handle.replace(/^@/, "")}`.toLowerCase();
  const kol = db.prepare("SELECT * FROM kols WHERE handle = ?").get(kolHandle);
  if (!kol) return res.status(404).json({ error: "KOL not found" });

  const biz = Number(scores.biz ?? scores.trust);
  const research = Number(scores.research ?? scores.alpha);
  const ethics = Number(scores.ethics ?? scores.winRate);
  const reputation = Number(scores.reputation ?? scores.trust ?? 3);
  const safety = Number(scores.safety ?? scores.risk);
  const arr = [biz, research, ethics, reputation, safety];
  if (arr.some((n) => Number.isNaN(n) || n < 1 || n > 5)) {
    return res.status(400).json({ error: "scores must be 1..5" });
  }
  if (!isAdmin && (arr.every((n) => n === 1) || arr.every((n) => n === 5))) {
    return res.status(400).json({ error: "all 1-star/all 5-star are blocked" });
  }

  const user = db.prepare("SELECT * FROM users WHERE wallet = ?").get(walletLc);
  if (!isAdmin && user?.is_blacklisted) return res.status(403).json({ error: "wallet is blacklisted" });
  const now = new Date().toISOString();
  if (!isAdmin && user?.last_vote_at && Date.now() - new Date(user.last_vote_at).getTime() < 15000) {
    return res.status(429).json({ error: "voting too frequently, slow down" });
  }

  const voteCount = user?.vote_count || 0;
  const weight = getUserWeight(voteCount);
  const totalScore = Number((arr.reduce((a, b) => a + b, 0) * 0.2).toFixed(2));

  db.prepare(
    "INSERT OR IGNORE INTO users (wallet, vote_count, reputation_weight, last_vote_at) VALUES (?, 0, ?, ?)"
  ).run(walletLc, weight, now);

  const existing = db.prepare("SELECT * FROM votes WHERE wallet = ? AND kol_id = ?").get(walletLc, kol.id);
  // Anti-spam: same user can rate same KOL once per 24h.
  if (!isAdmin && existing?.updated_at) {
    const lastAtMs = new Date(existing.updated_at).getTime();
    const nowMs = Date.now();
    const limitMs = 24 * 60 * 60 * 1000;
    const nextMs = lastAtMs + limitMs;
    if (!Number.isNaN(lastAtMs) && nowMs < nextMs) {
      return res.status(429).json({
        code: "DAILY_KOL_VOTE_LIMIT",
        error: "防止刷评，同一用户每日仅允许评价一次。",
        lastVoteAt: existing.updated_at,
        nextVoteAt: new Date(nextMs).toISOString()
      });
    }
  }
  if (existing) {
    db.prepare(
      "INSERT INTO vote_history (vote_id, wallet, kol_id, biz, research, ethics, reputation, safety, comment, total_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(existing.id, walletLc, kol.id, existing.biz, existing.research, existing.ethics, existing.reputation, existing.safety, existing.comment, existing.total_score);

    db.prepare(
      "UPDATE votes SET biz = ?, research = ?, ethics = ?, reputation = ?, safety = ?, comment = ?, total_score = ?, weight = ?, updated_at = ? WHERE id = ?"
    ).run(biz, research, ethics, reputation, safety, comment, totalScore, weight, now, existing.id);
  } else {
    db.prepare(
      "INSERT INTO votes (wallet, kol_id, biz, research, ethics, reputation, safety, comment, total_score, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(walletLc, kol.id, biz, research, ethics, reputation, safety, comment, totalScore, weight);

    const newCount = voteCount + 1;
    db.prepare("UPDATE users SET vote_count = ?, reputation_weight = ?, last_vote_at = ? WHERE wallet = ?").run(
      newCount,
      getUserWeight(newCount),
      now,
      walletLc
    );
  }

  refreshKolStats(kol.id);
  const nowIso = new Date().toISOString();
  res.json({
    ok: true,
    totalScore,
    lastVoteAt: nowIso,
    nextVoteAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
});

app.post("/api/exposes", upload.array("evidence", 6), (req, res) => {
  const { twitterId, title, content, event } = req.body || {};
  const eventText = String(content || event || "").trim();
  const topic = String(title || "").trim();
  const topicLen = [...topic].length;
  if (!twitterId || !topic || !eventText) return res.status(400).json({ error: "twitterId, title and content are required" });
  if (topicLen < 10 || topicLen > 30) return res.status(400).json({ error: "title length must be 10-30 chars" });
  const files = (req.files || []).map((f) => `/uploads/${f.filename}`);
  if (!files.length) return res.status(400).json({ error: "evidence image/video required" });
  const handle = extractTwitterHandleFromSubjectId(twitterId);
  const twitterIdStored = handle ? `https://x.com/${handle}` : String(twitterId).trim();
  db.prepare("INSERT INTO exposes (title, twitter_id, event_text, credibility, evidence_json) VALUES (?, ?, ?, ?, ?)").run(
    topic,
    twitterIdStored,
    eventText,
    "待审核",
    JSON.stringify(files)
  );
  res.json({ ok: true, files });
});

app.get("/api/exposes", async (_req, res) => {
  try {
    const rawRows = db
      .prepare("SELECT id, title, twitter_id, event_text, credibility, evidence_json, created_at, views FROM exposes ORDER BY id DESC LIMIT 100")
      .all();
    const getKolName = db.prepare("SELECT display_name FROM kols WHERE lower(handle) = ?");
    const getCacheName = db.prepare("SELECT display_name FROM kol_api_cache WHERE lower(handle) = ?");

    const needRefresh = new Set();
    for (const r of rawRows) {
      const sh = extractTwitterHandleFromSubjectId(r.twitter_id);
      if (!sh) continue;
      const dn = (getKolName.get(sh)?.display_name || "").trim() || (getCacheName.get(sh)?.display_name || "").trim();
      const av = getStoredAvatarUrl(sh);
      if (!dn || !av) needRefresh.add(sh);
    }

    const MAX_REFRESH = 15;
    let n = 0;
    for (const sh of needRefresh) {
      if (n >= MAX_REFRESH) break;
      if (RAPIDAPI_KEY) {
        await fetchProfileForAvatarCache(sh);
        n++;
      }
    }

    const likeCounts = {};
    const discussCounts = {};
    const ids = rawRows.map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      db.prepare(`SELECT expose_id, COUNT(*) AS c FROM expose_reactions WHERE reaction = 1 AND expose_id IN (${ph}) GROUP BY expose_id`)
        .all(...ids)
        .forEach((r) => {
          likeCounts[r.expose_id] = r.c || 0;
        });
      db.prepare(`SELECT expose_id, COUNT(*) AS c FROM expose_comments WHERE expose_id IN (${ph}) GROUP BY expose_id`)
        .all(...ids)
        .forEach((r) => {
          discussCounts[r.expose_id] = r.c || 0;
        });
    }

    const rows = rawRows.map((r) => {
      const evidence = JSON.parse(r.evidence_json || "[]");
      const subjectHandle = extractTwitterHandleFromSubjectId(r.twitter_id);
      let subjectName = "";
      if (subjectHandle) {
        subjectName = (getKolName.get(subjectHandle)?.display_name || "").trim();
        if (!subjectName) subjectName = (getCacheName.get(subjectHandle)?.display_name || "").trim();
      }
      const subjectAvatarUrl = subjectHandle ? getStoredAvatarUrl(subjectHandle) : "";
      return {
        id: r.id,
        title: r.title || "",
        twitter_id: r.twitter_id,
        event_text: r.event_text,
        credibility: r.credibility,
        created_at: r.created_at,
        views: Number(r.views || 0),
        likes: Number(likeCounts[r.id] || 0),
        discuss_count: Number(discussCounts[r.id] || 0),
        evidence,
        subject_handle: subjectHandle,
        subject_name: subjectName,
        subject_avatar_url: subjectAvatarUrl || null
      };
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || "exposes failed" });
  }
});

app.post("/api/admin/exposes/:id/review", authAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { credibility } = req.body || {};
  const allowed = ["完全可信", "存疑", "不可信", "待审核"];
  const next = allowed.includes(credibility) ? credibility : null;
  if (!id || !next) return res.status(400).json({ error: "invalid id or credibility" });
  db.prepare("UPDATE exposes SET credibility = ? WHERE id = ?").run(next, id);
  res.json({ ok: true });
});

app.get("/api/exposes/:id/comments", (req, res) => {
  const exposeId = Number(req.params.id);
  if (!exposeId) return res.status(400).json({ error: "invalid expose id" });
  const rows = db
    .prepare("SELECT id, wallet, content, created_at FROM expose_comments WHERE expose_id = ? ORDER BY created_at ASC")
    .all(exposeId)
    .map((r) => ({
      id: r.id,
      author: String(r.wallet || "").replace(/^twitter:/i, "@"),
      content: r.content,
      created_at: r.created_at
    }));
  res.json(rows);
});

app.post("/api/exposes/:id/comments", (req, res) => {
  const exposeId = Number(req.params.id);
  const tw = getTwitterUserFromRequest(req);
  if (!tw) return res.status(401).json({ error: "请先登录 X（推特）" });
  const wallet = `twitter:${(tw.username || tw.handle?.replace(/^@/, "") || "").toLowerCase()}`;
  const text = String(req.body?.content || "").trim();
  if (!exposeId || !text) return res.status(400).json({ error: "invalid expose id or empty content" });
  const expose = db.prepare("SELECT id FROM exposes WHERE id = ?").get(exposeId);
  if (!expose) return res.status(404).json({ error: "expose not found" });
  db.prepare("INSERT INTO expose_comments (expose_id, wallet, content) VALUES (?, ?, ?)").run(exposeId, wallet, text);
  res.json({ ok: true });
});

app.post("/api/exposes/:id/view", (req, res) => {
  const exposeId = Number(req.params.id);
  if (!exposeId) return res.status(400).json({ error: "invalid expose id" });
  const existed = db.prepare("SELECT id, views FROM exposes WHERE id = ?").get(exposeId);
  if (!existed) return res.status(404).json({ error: "expose not found" });
  db.prepare("UPDATE exposes SET views = COALESCE(views, 0) + 1 WHERE id = ?").run(exposeId);
  const row = db.prepare("SELECT views FROM exposes WHERE id = ?").get(exposeId);
  res.json({ ok: true, views: Number(row?.views || 0) });
});

app.post("/api/exposes/:id/react", (req, res) => {
  const exposeId = Number(req.params.id);
  const tw = getTwitterUserFromRequest(req);
  if (!tw) return res.status(401).json({ error: "请先登录 X（推特）" });
  if (!exposeId) return res.status(400).json({ error: "invalid expose id" });
  const wallet = `twitter:${(tw.username || tw.handle?.replace(/^@/, "") || "").toLowerCase()}`;
  const expose = db.prepare("SELECT id FROM exposes WHERE id = ?").get(exposeId);
  if (!expose) return res.status(404).json({ error: "expose not found" });
  const existing = db.prepare("SELECT reaction FROM expose_reactions WHERE expose_id = ? AND wallet = ?").get(exposeId, wallet);
  let reaction = 1;
  if (existing?.reaction === 1) {
    db.prepare("DELETE FROM expose_reactions WHERE expose_id = ? AND wallet = ?").run(exposeId, wallet);
    reaction = 0;
  } else if (existing) {
    db.prepare("UPDATE expose_reactions SET reaction = 1, created_at = datetime('now') WHERE expose_id = ? AND wallet = ?").run(exposeId, wallet);
  } else {
    db.prepare("INSERT INTO expose_reactions (expose_id, wallet, reaction) VALUES (?, ?, 1)").run(exposeId, wallet);
  }
  const likes = db.prepare("SELECT COUNT(*) AS c FROM expose_reactions WHERE expose_id = ? AND reaction = 1").get(exposeId).c || 0;
  res.json({ ok: true, reaction, likes: Number(likes) });
});

app.post("/api/kol-submissions", (req, res) => {
  const { twitterLink, intro, tag, isLeadTrade } = req.body || {};
  if (!twitterLink) return res.status(400).json({ error: "twitterLink is required" });
  db.prepare(
    "INSERT INTO kol_submissions (twitter_link, intro, tag, is_lead_trade, status) VALUES (?, ?, ?, ?, 'pending')"
  ).run(twitterLink, intro || "", tag || "", isLeadTrade ? 1 : 0);
  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || !bcrypt.compareSync(password || "", ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "8h" });
  return res.json({ token });
});

app.get("/api/admin/submissions", authAdmin, (_req, res) => {
  const getKolName = db.prepare("SELECT display_name FROM kols WHERE lower(handle) = ?");
  const getCacheName = db.prepare("SELECT display_name FROM kol_api_cache WHERE lower(handle) = ?");
  const rows = db
    .prepare("SELECT * FROM kol_submissions ORDER BY id DESC")
    .all()
    .map((row) => {
      const subjectHandle = extractTwitterHandleFromSubjectId(row.twitter_link);
      let subjectName = "";
      if (subjectHandle) {
        subjectName = (getKolName.get(subjectHandle)?.display_name || "").trim();
        if (!subjectName) subjectName = (getCacheName.get(subjectHandle)?.display_name || "").trim();
      }
      return { ...row, subject_handle: subjectHandle, subject_name: subjectName };
    });
  res.json(rows);
});

app.post("/api/admin/submissions/:id/review", authAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { action, note = "" } = req.body || {};
  const row = db.prepare("SELECT * FROM kol_submissions WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "submission not found" });
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve/reject" });

  if (action === "approve") {
    const handle = extractTwitterHandleFromSubjectId(row.twitter_link) || `kol_${id}`;
    db.prepare(
      "INSERT OR IGNORE INTO kols (handle, twitter_uid, tags, intro, is_lead_trade) VALUES (?, ?, ?, ?, ?)"
    ).run(handle, `@${handle}`, row.tag || "", row.intro || "", row.is_lead_trade || 0);
    const kolRow = db.prepare("SELECT id, handle FROM kols WHERE lower(handle) = ?").get(handle);
    if (kolRow) {
      refreshSingleKolFromTwitter(kolRow).catch(() => {});
    }
  }
  db.prepare("UPDATE kol_submissions SET status = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    action,
    note,
    id
  );
  res.json({ ok: true });
});

app.post("/api/admin/sync-followers", authAdmin, async (_req, res) => {
  if (!RAPIDAPI_KEY) return res.status(400).json({ error: "RAPIDAPI_KEY not configured" });
  try {
    await syncTwitterFollowers();
    writeSyncMeta({ ...readSyncMeta(), followersSyncAt: Date.now() });
    backfillFromApiCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/discover-from-following", authAdmin, async (_req, res) => {
  try {
    const { discoverKolsFromFollowing } = require("./scripts/discover-kols-from-following");
    const result = await discoverKolsFromFollowing();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/discover-from-binancezh", authAdmin, async (_req, res) => {
  try {
    const { discoverFromBinancezhFollowers } = require("./scripts/discover-from-binancezh-followers");
    const result = await discoverFromBinancezhFollowers();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/discover-multi-sources", authAdmin, async (_req, res) => {
  try {
    const { main } = require("./scripts/discover-multi-sources");
    const result = await main();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/blacklist", authAdmin, (req, res) => {
  const { wallet, blocked } = req.body || {};
  if (!wallet) return res.status(400).json({ error: "wallet required" });
  const lc = wallet.toLowerCase();
  db.prepare("INSERT OR IGNORE INTO users (wallet, vote_count, reputation_weight) VALUES (?, 0, 1.0)").run(lc);
  db.prepare("UPDATE users SET is_blacklisted = ? WHERE wallet = ?").run(blocked ? 1 : 0, lc);
  res.json({ ok: true });
});

// 本地：dist/。Vercel：构建生成的 public/（见 npm run build）。无静态中间件时 GET / 会落到 Express 默认处理 → “Cannot GET /”。
const distDir = path.join(__dirname, "dist");
const publicDir = path.join(__dirname, "public");
if (process.env.VERCEL) {
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: "index.html", maxAge: "1h" }));
  }
} else if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
} else {
  app.use(express.static(__dirname));
}

if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API + Web running on http://localhost:${PORT}`);
    const envOk = fs.existsSync(ENV_FILE);
    const xOk = Boolean(TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET);
    // eslint-disable-next-line no-console
    console.log(
      `[env] .env: ${ENV_FILE} | exists=${envOk} | X OAuth=${xOk ? "ready" : "MISSING (检查 TWITTER_CLIENT_ID/SECRET)"}${dotenvResult.error ? ` | dotenv: ${dotenvResult.error.message}` : ""}`
    );
    // eslint-disable-next-line no-console
    console.log(`[env] 本进程 pid=${process.pid}，勿关闭此窗口；503 且 health 显示 twitterOAuthConfigured=false 时多为端口被旧进程占用。`);
    // eslint-disable-next-line no-console
    console.log(`[env] 管理员 X 账号数量: ${getAdminTwitterHandleSet().size}（来自 .env 的 ADMIN_TWITTER_HANDLES）`);
  });

  httpServer.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `\n[fatal] 端口 ${PORT} 已被占用。浏览器会连到「旧」服务，出现 Twitter login not configured。\n` +
          `  在 PowerShell 执行：netstat -ano | findstr :${PORT}\n` +
          `  记下最后一列 PID，再执行：taskkill /PID <该数字> /F\n` +
          `  然后重新：node server.js\n`
      );
    }
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = app;
