require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const path = require("path");
const namecheap = require("./namecheap");
const dynadot = require("./dynadot");
const cloudflare = require("./cloudflare");
const serverManager = require("./serverManager");
const megaService = require("./megaService");
const bundlerService = require("./bundlerService");
const { encryptFile, decryptFile } = require("./security/security");
const galaxyService = require("./galaxyService");

// Load environment variables
const secret = process.env.BOT_SECRET || "DEVELOPMENT_MODE";
console.log("✅ Standard .env loaded successfully.");

// Configuration
const token = process.env.BOT_TOKEN;
const BACKUP_TOKEN = process.env.BACKUP_TOKEN;
const BACKUP_DIR = path.join(__dirname, "backups");
const USERS_DIR = path.join(__dirname, "users");
const PRODUCTION_DIR = path.join(__dirname, "production");

// Ensure users directory exists
if (!fs.existsSync(USERS_DIR)) {
  fs.mkdirSync(USERS_DIR, { recursive: true });
}

// Helper: Get user domain file path
const getUserDomainsFile = (chatId) => {
  const userFolder = path.join(USERS_DIR, String(chatId));
  if (!fs.existsSync(userFolder)) {
    fs.mkdirSync(userFolder, { recursive: true });
  }
  return path.join(userFolder, "domains.json");
};

// Helper: Get user settings file path
const getUserSettingsFile = (chatId) => {
  const userFolder = path.join(USERS_DIR, String(chatId));
  if (!fs.existsSync(userFolder)) {
    fs.mkdirSync(userFolder, { recursive: true });
  }
  return path.join(userFolder, "settings.json");
};

// Load User Settings
const loadSettings = (chatId) => {
  try {
    const settingsFile = getUserSettingsFile(chatId);
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    }
  } catch (err) {
    console.error(`Error reading settings.json for user ${chatId}:`, err);
  }
  return {
    auto_cf_waf: false,
    cf_waf_options: {
      enablePhOnly: false,
      enableVpnBlocking: false,
      enableAsnWhitelist: true, // Default to true as per user request
    },
  };
};

// Save User Settings
const saveSettings = (chatId, settings) => {
  fs.writeFileSync(
    getUserSettingsFile(chatId),
    JSON.stringify(settings, null, 2),
  );
};

// Helper: Escape HTML characters for Telegram
const escapeHtml = (text) => {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

// Ensure production directory exists
if (!fs.existsSync(PRODUCTION_DIR)) {
  fs.mkdirSync(PRODUCTION_DIR, { recursive: true });
}

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR);
}

// Initialize Bot
const bot = new TelegramBot(token, { polling: true });

// Patch editMessageText to ignore "message is not modified" errors
const originalEditMessageText = bot.editMessageText.bind(bot);
bot.editMessageText = (...args) => {
  return originalEditMessageText(...args).catch((err) => {
    if (err.message && err.message.includes("message is not modified")) {
      return; // Ignore
    }
    throw err;
  });
};

// Patch editMessageReplyMarkup to ignore "message is not modified" errors
const originalEditMessageReplyMarkup = bot.editMessageReplyMarkup.bind(bot);
bot.editMessageReplyMarkup = (...args) => {
  return originalEditMessageReplyMarkup(...args).catch((err) => {
    if (err.message && err.message.includes("message is not modified")) {
      return; // Ignore
    }
    throw err;
  });
};

// Global Unhandled Rejection Handler
process.on("unhandledRejection", (reason, promise) => {
  if (
    reason &&
    reason.message &&
    reason.message.includes("message is not modified")
  ) {
    return; // Silently ignore
  }
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Access Control: Allowed Usernames
const ALLOWED_USERNAMES = ["Pogito090", "deym007"];

const checkAccess = (data) => {
  const from = data.from || (data.message ? data.message.from : {});
  const username = from.username;
  const chatId = data.message
    ? data.message.chat.id
    : data.chat
      ? data.chat.id
      : data.message_id
        ? data.chat_id
        : null;

  console.log(`[ACCESS_CHECK] User: @${username}, ChatID: ${chatId}`);

  // [MODIFIED] Access is now open to all, but data is separated by chatId
  if (!chatId) return false;

  return true;
};

// Auto-Backup State
let autoBackupInterval = null;
let statusHeartbeatInterval = null;
const subscribedUsers = new Set();
const heartbeatSubscribers = new Set();

// User State Management
const userStates = {};

// Rate Limiting State
const rateLimits = {};

/**
 * Helper: Check if user is rate limited
 * Balanced Limit: 100 requests per minute, 1 second flood protection
 */
const isRateLimited = (chatId) => {
  const now = Date.now();
  if (!rateLimits[chatId]) {
    rateLimits[chatId] = {
      lastRequest: 0,
      history: [],
    };
  }

  const userLimit = rateLimits[chatId];

  // 1. Flood Protection (1 second gap - enough for normal clicking)
  if (now - userLimit.lastRequest < 1000) {
    return {
      limited: true,
      reason: "too_fast",
      message: "⚠️ <b>Wait a second!</b> Please don't spam the buttons.",
    };
  }

  // 2. Per Minute Check (100 requests per 60 seconds - very generous for normal users)
  userLimit.history = userLimit.history.filter(
    (timestamp) => now - timestamp < 60000,
  );

  if (userLimit.history.length >= 100) {
    const oldestTimestamp = userLimit.history[0];
    const waitTime = Math.ceil((60000 - (now - oldestTimestamp)) / 1000);
    return {
      limited: true,
      reason: "too_many",
      message: `🛑 <b>Slow down!</b> You've reached the limit. Please wait <b>${waitTime}s</b>.`,
    };
  }

  // Not limited - update history and lastRequest
  userLimit.lastRequest = now;
  userLimit.history.push(now);
  return { limited: false };
};

// Format Time with AM/PM
const formatTime = () => {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
};

// Auto-Cleanup: Keep only latest 30 backups per domain
const cleanupBackups = (domainName) => {
  try {
    const domainBackupDir = path.join(BACKUP_DIR, domainName);
    if (!fs.existsSync(domainBackupDir)) return;

    const files = fs
      .readdirSync(domainBackupDir)
      .filter((file) => file.endsWith(".sql.enc"))
      .map((file) => ({
        name: file,
        path: path.join(domainBackupDir, file),
        time: fs.statSync(path.join(domainBackupDir, file)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time); // Newest first

    if (files.length > 30) {
      const filesToDelete = files.slice(30);
      filesToDelete.forEach((file) => {
        fs.unlinkSync(file.path);
        console.log(`[CLEANUP] Deleted old backup: ${file.name}`);
      });
    }
  } catch (err) {
    console.error(`[CLEANUP_ERROR] ${domainName}:`, err.message);
  }
};

// Helper: Generate unique clone group ID
const generateCloneGroupId = () => {
  return "cg_" + Math.random().toString(36).substring(2, 15);
};

// Helper: Get all domains for a user grouped by clone_group_id
const getDomainsByCloneGroup = (chatId) => {
  const domains = loadDomains(chatId);
  const groups = {};
  const ungrouped = [];

  domains.forEach((domain, index) => {
    if (domain.clone_group_id) {
      if (!groups[domain.clone_group_id]) {
        groups[domain.clone_group_id] = {
          primary: null,
          clones: [],
          all: [],
        };
      }
      groups[domain.clone_group_id].all.push({ ...domain, index });
      if (domain.is_primary) {
        groups[domain.clone_group_id].primary = { ...domain, index };
      } else {
        groups[domain.clone_group_id].clones.push({ ...domain, index });
      }
    } else {
      ungrouped.push({ ...domain, index });
    }
  });

  return { groups, ungrouped };
};

// Helper: Auto-detect potential clones based on URL similarity
const detectPotentialClones = (chatId, newUrl) => {
  const domains = loadDomains(chatId);
  const newDomainBase = getDomainFromUrl(newUrl);

  // Extract base name (e.g., "ubs-international" from "ubs-international.cv")
  const getBaseName = (domain) => {
    return domain.replace(
      /\.(cv|sbs|cfd|cyou|com|net|org|biz|info|space|xyz|io|co|app|dev)[.\/]?.*$/i,
      "",
    );
  };

  const newBaseName = getBaseName(newDomainBase);

  const potentialClones = domains.filter((d) => {
    const existingBase = getBaseName(getDomainFromUrl(d.url));
    return existingBase === newBaseName && d.url !== newUrl;
  });

  return potentialClones;
};

// Helper: Get primary domain for a clone group
const getPrimaryDomain = (chatId, cloneGroupId) => {
  const domains = loadDomains(chatId);
  return domains.find((d) => d.clone_group_id === cloneGroupId && d.is_primary);
};

// Helper: Set domain as primary for its clone group
const setDomainAsPrimary = (chatId, domainIndex) => {
  const domains = loadDomains(chatId);
  if (domainIndex < 0 || domainIndex >= domains.length) return false;

  const targetDomain = domains[domainIndex];
  const cloneGroupId = targetDomain.clone_group_id;

  if (!cloneGroupId) {
    // Create new clone group for this domain
    targetDomain.clone_group_id = generateCloneGroupId();
    targetDomain.is_primary = true;
  } else {
    // Unset any existing primary in this group
    domains.forEach((d) => {
      if (d.clone_group_id === cloneGroupId) {
        d.is_primary = false;
      }
    });
    // Set new primary
    targetDomain.is_primary = true;
  }

  saveDomains(chatId, domains);
  return true;
};

// --- Helpers ---

// Calculate Detailed Balance across all domains for a user
// [MODIFIED] Now uses Galaxy API directly for merchant balance
const getTotalBalance = async (chatId, onProgress) => {
  const domains = loadDomains(chatId);
  
  // Filter to only primary domains (or ungrouped domains)
  // If a clone group has no primary set, use the first domain in that group
  const processedGroups = new Set();
  const domainsToCheck = [];
  
  domains.forEach((domain, index) => {
    if (domain.clone_group_id) {
      if (!processedGroups.has(domain.clone_group_id)) {
        // First time seeing this group - find primary or use this one
        const groupDomains = domains.filter(d => d.clone_group_id === domain.clone_group_id);
        const primary = groupDomains.find(d => d.is_primary);
        domainsToCheck.push(primary || groupDomains[0]);
        processedGroups.add(domain.clone_group_id);
      }
      // Skip other domains in this group
    } else {
      // Not in a clone group - check normally
      domainsToCheck.push(domain);
    }
  });
  
  let totalAdmin = 0;
  let totalMerchant = 0;

  // Track stats
  let successCount = 0;
  let failedCount = 0;
  const failedDomains = [];

  // Fetch Galaxy merchant balance directly (single call, not per-domain)
  if (galaxyService.isConfigured()) {
    try {
      const galaxyBal = await galaxyService.getBalance();
      if (galaxyBal.success) {
        totalMerchant = galaxyBal.balance;
      }
    } catch (err) {
      // Galaxy balance fetch failed — continue with 0
    }
  }

  const promises = domainsToCheck.map(async (domain) => {
    try {
      const api = getApi(domain.url);
      const results = await Promise.allSettled([api.get("/system-info")]);

      // Process Admin Balance
      let adminSuccess = false;
      if (results[0].status === "fulfilled" && results[0].value.data.success) {
        const s = results[0].value.data.data;
        const adminVal =
          parseFloat(String(s.admin_balance).replace(/[^\d.-]/g, "")) || 0;
        totalAdmin += adminVal;
        adminSuccess = true;
      }

      if (adminSuccess) {
        successCount++;
        if (onProgress)
          onProgress(
            domain.name,
            true,
            successCount,
            failedCount,
            failedDomains,
          );
      } else {
        failedCount++;
        failedDomains.push(domain.name);
        if (onProgress)
          onProgress(
            domain.name,
            false,
            successCount,
            failedCount,
            failedDomains,
          );
      }
    } catch (err) {
      // Silently skip failed domains for calculation
      failedCount++;
      failedDomains.push(domain.name);
      if (onProgress)
        onProgress(
          domain.name,
          false,
          successCount,
          failedCount,
          failedDomains,
        );
    }
  });

  await Promise.all(promises);
  return {
    admin: totalAdmin,
    merchant: totalMerchant,
    total: totalMerchant - totalAdmin, // Owner Earning = Merchant - Site Balance
  };
};

// Load Domains from JSON (Per User)
const loadDomains = (chatId) => {
  try {
    const domainsFile = getUserDomainsFile(chatId);
    if (fs.existsSync(domainsFile)) {
      const data = fs.readFileSync(domainsFile, "utf8").trim();
      if (!data) return []; // Handle empty file
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`Error reading domains.json for user ${chatId}:`, err);
  }
  return [];
};

// Check if domain belongs to user
const getDomainFromUrl = (str) => {
  if (!str) return "";
  // Remove protocol
  let domain = str.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "");
  // Remove path and query strings
  domain = domain.split("/")[0].split("?")[0];
  return domain.toLowerCase();
};

const isDomainOwner = (chatId, domain) => {
  const userDomainsData = loadDomains(chatId);
  const domainToMatch = domain.toLowerCase();
  return userDomainsData.some((d) => {
    const trackedName = (d.name || "").toLowerCase();
    const trackedDomain = (d.domain || "").toLowerCase();
    return (
      getDomainFromUrl(trackedName) === domainToMatch ||
      getDomainFromUrl(trackedDomain) === domainToMatch
    );
  });
};

// Save Domains to JSON (Per User)
const saveDomains = (chatId, domains) => {
  fs.writeFileSync(
    getUserDomainsFile(chatId),
    JSON.stringify(domains, null, 2),
  );
};

// Update Domain ZoneID (Per User)
const updateDomainZoneId = (chatId, domainName, zoneId) => {
  const domains = loadDomains(chatId);
  let updated = false;
  const domainToMatch = domainName.toLowerCase();

  for (const d of domains) {
    const trackedName = (d.name || "").toLowerCase();
    const trackedDomain = (d.domain || "").toLowerCase();

    if (
      getDomainFromUrl(trackedName) === domainToMatch ||
      getDomainFromUrl(trackedDomain) === domainToMatch
    ) {
      d.zone_id = zoneId;
      updated = true;
    }
  }

  if (updated) {
    fs.writeFileSync(
      getUserDomainsFile(chatId),
      JSON.stringify(domains, null, 2),
    );
  }
  return updated;
};

// Save Domain to JSON (Per User)
// [MODIFIED] Now auto-detects clones and assigns clone_group_id
const saveDomain = (chatId, newDomain) => {
  const domains = loadDomains(chatId);
  
  // Check for potential clones based on URL similarity
  const potentialClones = detectPotentialClones(chatId, newDomain.url);
  
  if (potentialClones.length > 0) {
    // Found potential clones - assign to existing clone group or create new one
    const existingClone = potentialClones[0];
    
    if (existingClone.clone_group_id) {
      // Join existing clone group
      newDomain.clone_group_id = existingClone.clone_group_id;
      newDomain.is_primary = false; // Not primary by default
    } else {
      // Create new clone group for both domains
      const newGroupId = generateCloneGroupId();
      
      // Update existing domain to be part of new group and primary
      const existingIndex = domains.findIndex(d => d.url === existingClone.url);
      if (existingIndex !== -1) {
        domains[existingIndex].clone_group_id = newGroupId;
        domains[existingIndex].is_primary = true;
      }
      
      // Set new domain as clone (not primary)
      newDomain.clone_group_id = newGroupId;
      newDomain.is_primary = false;
    }
    
    console.log(`[CLONE_DETECTED] ${newDomain.name} grouped with ${existingClone.name} (Group: ${newDomain.clone_group_id})`);
  }
  // If no clones detected, domain has no clone_group_id (null/undefined)
  
  domains.push(newDomain);
  fs.writeFileSync(
    getUserDomainsFile(chatId),
    JSON.stringify(domains, null, 2),
  );
};

// Delete Domain from JSON (Per User)
const deleteDomain = (chatId, index) => {
  const domains = loadDomains(chatId);
  if (index >= 0 && index < domains.length) {
    domains.splice(index, 1);
    fs.writeFileSync(
      getUserDomainsFile(chatId),
      JSON.stringify(domains, null, 2),
    );
    return true;
  }
  return false;
};

// Auto-Backup Logic (Iterates through all users)
const runAutoBackup = async () => {
  console.log(`⏰ Running Auto-Backup for all users...`);

  // Get all user IDs from the users directory
  const userIds = fs
    .readdirSync(USERS_DIR)
    .filter((f) => fs.statSync(path.join(USERS_DIR, f)).isDirectory());

  for (const userId of userIds) {
    const domains = loadDomains(userId);
    if (domains.length === 0) continue;

    console.log(
      `[AUTO_BACKUP] Processing User ${userId} (${domains.length} domains)`,
    );

    let summary = "";
    let successCount = 0;

    for (const domain of domains) {
      try {
        // Ensure domain specific backup folder exists
        const domainBackupDir = path.join(BACKUP_DIR, domain.name);
        if (!fs.existsSync(domainBackupDir)) {
          fs.mkdirSync(domainBackupDir, { recursive: true });
        }

        const api = getApi(domain.url);
        const response = await api.post("/create-backup", {
          api_name: "bot_auto",
        });

        if (response.data.success) {
          const { filename, sql_content, original_size } = response.data.data;
          const filePath = path.join(domainBackupDir, filename);
          fs.writeFileSync(filePath, sql_content);

          const encPath = filePath + ".enc";
          encryptFile(filePath, encPath, secret);
          fs.unlinkSync(filePath);

          // Upload to MEGA
          try {
            await megaService.uploadBackup(encPath, domain.name);
            // Optional: Delete local encrypted file after upload to save more space
            // fs.unlinkSync(encPath);
          } catch (megaErr) {
            console.error(
              `[AUTO_BACKUP_MEGA_ERROR] ${domain.name}:`,
              megaErr.message,
            );
            summary += `⚠️ ${domain.name}: Backup created but MEGA upload failed\n`;
          }

          cleanupBackups(domain.name);
          successCount++;
        } else {
          summary += `❌ ${domain.name}: Failed (${response.data.error})\n`;
        }
      } catch (err) {
        summary += `❌ ${domain.name}: Error (${err.message})\n`;
      }
    }

    // Notify User if they are subscribed
    if (
      subscribedUsers.has(Number(userId)) ||
      subscribedUsers.has(String(userId))
    ) {
      const message = `⏰ <b>Auto-Backup Completed</b>\n✅ Success: ${successCount}/${domains.length}\n🕒 Time: ${formatTime()}\n${summary ? "\nErrors:\n" + summary : ""}`;
      try {
        await bot.sendMessage(userId, message, { parse_mode: "HTML" });
      } catch (err) {
        console.error(`Failed to notify user ${userId}:`, err.message);
      }
    }
  }
};

const startAutoBackup = () => {
  if (autoBackupInterval) return;
  runAutoBackup(); // Run immediately once
  autoBackupInterval = setInterval(runAutoBackup, 5 * 60 * 1000); // 5 minutes

  // Start Heartbeat if there are subscribers
  startHeartbeat();
};

const stopAutoBackup = () => {
  if (autoBackupInterval) {
    clearInterval(autoBackupInterval);
    autoBackupInterval = null;
  }
  stopHeartbeat();
};

const startHeartbeat = () => {
  if (statusHeartbeatInterval) return;
  statusHeartbeatInterval = setInterval(async () => {
    if (heartbeatSubscribers.size === 0) return;

    const message = `🔄 <b>Auto-Backup Status:</b> Running Smoothly... ✅\n🕒 ${formatTime()}`;
    for (const chatId of heartbeatSubscribers) {
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: "HTML",
          disable_notification: true,
        });
      } catch (err) {
        console.error(`Heartbeat failed for ${chatId}:`, err.message);
      }
    }
  }, 10000); // 10 seconds
};

const stopHeartbeat = () => {
  if (statusHeartbeatInterval) {
    clearInterval(statusHeartbeatInterval);
    statusHeartbeatInterval = null;
  }
};

// Global Agent for keep-alive connections
const httpsAgent = new https.Agent({ keepAlive: true });

// Get API Client for specific URL
const getApi = (baseURL) => {
  return axios.create({
    baseURL: baseURL,
    httpsAgent: httpsAgent,
    headers: {
      "X-Backup-Token": BACKUP_TOKEN,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    timeout: 60000, // 60s timeout
  });
};

// Format Currency
const formatCurrency = (amount) => {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
  }).format(amount);
};

// --- Keyboards ---

const getNamecheapKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "🛒 Buy New Domain", callback_data: "buy_new_domain" }],
      [{ text: "� Search My Domains", callback_data: "nc_search_prompt" }],
      [
        { text: "✅ Active", callback_data: "nc_list:active" },
        { text: "❌ Expired", callback_data: "nc_list:expired" },
      ],
      [{ text: "🚫 Alert/Blocked", callback_data: "nc_list:blocked" }],
      [{ text: "📂 Show All (Recent)", callback_data: "nc_list:all" }],
      [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
    ],
  };
};

const getCloudflareKeyboard = () => {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ Add Domain (Auto Setup)",
          callback_data: "cf_add_domain_prompt",
        },
      ],
      [
        {
          text: "🛡️ Set Under Attack Mode",
          callback_data: "cf_protection_prompt",
        },
      ],
      [
        {
          text: "🔄 Change DNS IP",
          callback_data: "cf_change_ip_menu",
        },
      ],
      [{ text: "🔍 Search Domain", callback_data: "cf_search_prompt" }],
      [{ text: "📋 List All Domains", callback_data: "cf_list_zones:1" }],
      [
        {
          text: "⚙️ Cloudflare Management",
          callback_data: "cf_management_menu",
        },
      ],
      [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
    ],
  };
};

const COUNTRY_LIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "countries.json"), "utf8"),
);

const getCountryPickerKeyboard = (
  domain,
  whitelisted,
  page = 0,
  searchQuery = "",
) => {
  const buttons = [];
  let codes = Object.keys(COUNTRY_LIST);

  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    codes = codes.filter(
      (code) =>
        code.toLowerCase().includes(query) ||
        COUNTRY_LIST[code].name.toLowerCase().includes(query),
    );
  }

  const pageSize = 40; // 2 columns x 20 rows
  const start = page * pageSize;
  const end = Math.min(start + pageSize, codes.length);
  const totalPages = Math.ceil(codes.length / pageSize);

  // Header with Whitelisted Countries
  const whitelistedNames = whitelisted
    .filter((code) => COUNTRY_LIST[code])
    .map((code) => `${COUNTRY_LIST[code].flag} ${code}`)
    .join(", ");

  const headerText = whitelistedNames
    ? `✅ <b>Whitelisted Countries:</b>\n${whitelistedNames}\n━━━━━━━━━━━━━━━━━━`
    : "❌ <b>No countries whitelisted</b>\n━━━━━━━━━━━━━━━━━━";

  for (let i = start; i < end; i += 2) {
    const row = [];
    const code1 = codes[i];
    const isSelected1 = whitelisted.includes(code1);
    row.push({
      text: `${isSelected1 ? "✅" : ""} ${COUNTRY_LIST[code1].flag} ${COUNTRY_LIST[code1].name}`,
      callback_data: `cf_country_toggle_exec:${domain}:${code1}:${page}:${searchQuery || "none"}`,
    });

    if (i + 1 < end) {
      const code2 = codes[i + 1];
      const isSelected2 = whitelisted.includes(code2);
      row.push({
        text: `${isSelected2 ? "✅" : ""} ${COUNTRY_LIST[code2].flag} ${COUNTRY_LIST[code2].name}`,
        callback_data: `cf_country_toggle_exec:${domain}:${code2}:${page}:${searchQuery || "none"}`,
      });
    }
    buttons.push(row);
  }

  // Pagination Row
  const navRow = [];
  if (page > 0) {
    navRow.push({
      text: "⬅️ Previous",
      callback_data: `cf_country_picker:${domain}:${page - 1}:${searchQuery || "none"}`,
    });
  }
  navRow.push({
    text: `Page ${page + 1}/${totalPages || 1}`,
    callback_data: "noop",
  });
  if (page < totalPages - 1) {
    navRow.push({
      text: "Next ➡️",
      callback_data: `cf_country_picker:${domain}:${page + 1}:${searchQuery || "none"}`,
    });
  }
  buttons.push(navRow);

  // Search and Back buttons
  buttons.push([
    {
      text: "🔍 Search Country",
      callback_data: `cf_country_search_prompt:${domain}`,
    },
  ]);
  buttons.push([
    { text: "⬅️ Back to Manage", callback_data: `cf_manage:${domain}` },
  ]);

  return {
    inline_keyboard: buttons,
    header: headerText,
  };
};

const getCloudflareManagementKeyboard = (chatId) => {
  const settings = loadSettings(chatId);
  const options = settings.cf_waf_options;

  return {
    inline_keyboard: [
      [
        {
          text: `${settings.auto_cf_waf ? "✅" : "❌"} Auto-Enable WAF on Add`,
          callback_data: "toggle_cf_auto_waf",
        },
      ],
      [
        {
          text: `${options.enableAsnWhitelist ? "✅" : "❌"} ASN Whitelist`,
          callback_data: "toggle_cf_waf_asn",
        },
      ],
      [
        {
          text: `${options.enablePhOnly ? "✅" : "❌"} PH Only`,
          callback_data: "toggle_cf_waf_ph",
        },
      ],
      [
        {
          text: `${options.enableVpnBlocking ? "✅" : "❌"} VPN Blocking`,
          callback_data: "toggle_cf_waf_vpn",
        },
      ],
      [
        {
          text: `🌍 Country Whitelist Management`,
          callback_data: "cf_country_whitelist_menu",
        },
      ],
      [
        {
          text: "⬅️ Back to Cloudflare Menu",
          callback_data: "cloudflare_menu",
        },
      ],
    ],
  };
};

const getServerKeyboard = () => {
  return {
    inline_keyboard: [
      [
        {
          text: "📦 Deploy from Local (.zip)",
          callback_data: "server_deploy_local",
        },
      ],
      [
        {
          text: "🌐 Manage Existing Sites",
          callback_data: "server_manage_sites",
        },
      ],
      [
        {
          text: "🚀 Clone / Migrate Site",
          callback_data: "server_clone_prompt",
        },
      ],
      [
        {
          text: "🆕 Create New Site (PHP)",
          callback_data: "server_create_site_prompt",
        },
      ],
      [
        {
          text: "⏰ Manage Cron Jobs (cron-job.org)",
          callback_data: "server_cron_list",
        },
      ],
      [{ text: "📡 Check SSH Connection", callback_data: "server_check_ssh" }],
      [
        { text: "🖥️ VPS Health Check", callback_data: "server_vps_health" },
        { text: "🔄 Restart VPS", callback_data: "server_vps_restart" },
      ],
      [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
    ],
  };
};

const getDynadotKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "🛒 Buy New Domain (Balance)", callback_data: "dd_buy_domain" }],
      [{ text: "🔍 Check Availability", callback_data: "dd_check_domain" }],
      [{ text: "💰 Check Account Balance", callback_data: "dd_check_balance" }],
      [{ text: "📡 Update DNS (Nameservers)", callback_data: "dd_update_dns" }],
      [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
    ],
  };
};

const getDomainManageKeyboard = (domain) => {
  return {
    inline_keyboard: [
      [
        {
          text: "📡 Change DNS (Nameservers)",
          callback_data: `nc_dns:${domain}`,
        },
      ],
      [{ text: "⬅️ Back to My Domains", callback_data: "nc_my_domains" }],
      [{ text: "🏠 Main Menu", callback_data: "main_menu" }],
    ],
  };
};

const getDomainKeyboard = (chatId) => {
  const domains = loadDomains(chatId);

  // Primary Action: Check All
  const buttons = [
    [{ text: "💰 CHECK ALL MARKETS/DOMAINS", callback_data: "check_all" }],
  ];

  // Add/Delete Domain
  buttons.push([
    { text: "➕ Add Domain", callback_data: "add_domain" },
    { text: "➖ Delete Domain", callback_data: "delete_domain_menu" },
  ]);

  // Clone Management (if clones detected)
  const { groups } = getDomainsByCloneGroup(chatId);
  if (Object.keys(groups).length > 0) {
    buttons.push([
      { text: "📎 Clone Management", callback_data: "clone_management_menu" },
    ]);
  }

  // Namecheap Tools Menu
  buttons.push([
    { text: "🌐 NAMECHEAP TOOLS", callback_data: "namecheap_menu" },
  ]);

  // Dynadot Tools Menu
  buttons.push([{ text: "🌐 DYNADOT TOOLS", callback_data: "dynadot_menu" }]);

  // Cloudflare Tools Menu
  buttons.push([
    { text: "☁️ CLOUDFLARE TOOLS", callback_data: "cloudflare_menu" },
  ]);

  // Server Tools Menu (New)
  buttons.push([
    { text: "🖥️ SERVER TOOLS (CLONE)", callback_data: "server_menu" },
  ]);

  // Backup Menu
  buttons.push([{ text: "🗄️ BACKUP DATABASES", callback_data: "backup_menu" }]);

  // Refresh button
  buttons.push([
    { text: "🔄 Refresh Domain List", callback_data: "refresh_domains" },
  ]);

  return {
    inline_keyboard: buttons,
  };
};

const getBackupKeyboard = (isAutoBackupActive, chatId) => {
  const domains = loadDomains(chatId);
  const buttons = [];

  // Auto-Backup Toggle
  if (isAutoBackupActive) {
    buttons.push([
      {
        text: "🛑 Disable Auto-Backup (5m)",
        callback_data: "toggle_auto_backup",
      },
    ]);
  } else {
    buttons.push([
      {
        text: "✅ Enable Auto-Backup (5m)",
        callback_data: "toggle_auto_backup",
      },
    ]);
  }

  // Heartbeat Toggle (10s notification)
  buttons.push([
    {
      text: "🔔 Toggle 10s Status Notification",
      callback_data: "toggle_heartbeat",
    },
  ]);

  // Backup All
  buttons.push([
    { text: "💾 BACKUP ALL DATABASES", callback_data: "backup_all" },
  ]);

  // Individual Domain Backups
  const backupButtons = [];
  domains.forEach((d, index) => {
    backupButtons.push({
      text: `💾 Backup: ${d.name}`,
      callback_data: `backup_${index}`,
    });
  });

  // Split backup buttons into rows of 2
  for (let i = 0; i < backupButtons.length; i += 2) {
    buttons.push(backupButtons.slice(i, i + 2));
  }

  // Back button
  buttons.push([{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }]);

  return {
    inline_keyboard: buttons,
  };
};

const getDeleteDomainKeyboard = (chatId) => {
  const domains = loadDomains(chatId);
  const buttons = [];

  domains.forEach((d, index) => {
    buttons.push([
      { text: `❌ Delete: ${d.name}`, callback_data: `delete_domain_${index}` },
    ]);
  });

  buttons.push([{ text: "⬅️ Cancel / Back", callback_data: "main_menu" }]);

  return {
    inline_keyboard: buttons,
  };
};

const getBackKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
    ],
  };
};

// Clone Management Keyboard
const getCloneManagementKeyboard = (chatId) => {
  const domains = loadDomains(chatId);
  const { groups } = getDomainsByCloneGroup(chatId);
  
  const buttons = [];
  const groupKeys = Object.keys(groups);
  
  if (groupKeys.length === 0) {
    buttons.push([{ text: "ℹ️ No Clone Groups", callback_data: "noop" }]);
  } else {
    groupKeys.forEach((groupId, index) => {
      const group = groups[groupId];
      const primary = group.primary;
      const cloneCount = group.clones.length;
      
      const label = primary 
        ? `⭐ ${primary.name} (+${cloneCount} clones)`
        : `📎 Group ${index + 1} (${cloneCount + 1} domains)`;
      
      buttons.push([{ 
        text: label, 
        callback_data: `view_clone_group:${groupId}` 
      }]);
    });
  }
  
  // Add button to view all domains in list view
  buttons.push([{ 
    text: "📋 View All Domains", 
    callback_data: "view_all_domains_clone" 
  }]);
  
  buttons.push([{ 
    text: "⬅️ Back to Main Menu", 
    callback_data: "main_menu" 
  }]);
  
  return { inline_keyboard: buttons };
};

// --- Command Handlers ---

// 1. /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!checkAccess(msg)) return;
  // Clear any existing state
  if (userStates[chatId]) delete userStates[chatId];

  const message = `
1. 🤖 <b>System Monitor</b>
━━━━━━━━━━━━━━━━━━
Select an option below:
(Tip: Send /help for instructions)
`;
  bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    reply_markup: getDomainKeyboard(chatId),
  });
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!checkAccess(msg)) return;
  const message = `
<b>📚 Bot Instructions & Commands</b>
━━━━━━━━━━━━━━━━━━

<b>🌐 Domain Management:</b>
• <b>➕ Add New Domain:</b> Add a site to your tracked list by providing a display name and API URL.
• <b>🔎 Search My Domains:</b> Find specific domains in your tracked list or via Namecheap tools.
• <b>💰 Check All Markets:</b> Instantly fetch balances and admin earnings across all your sites.

<b>☁️ Cloudflare Tools:</b>
• <b>🔍 Search Zone:</b> Manage DNS and settings for domains you've added.
• <b>🚀 Auto Setup:</b> Automatically configure a new domain (Add Zone + DNS + Proxy).
• <b>🛠️ DNS Manage:</b> Update nameservers or records directly.

<b>🖥️ Server Operations:</b>
• <b>📦 Deploy from Local:</b> Upload a .zip file and deploy it to your server.
• <b>🚀 Clone / Migrate:</b> Clone files and databases from one site to another.
• <b>🆕 Create New Site:</b> Set up a fresh PHP environment on your server instantly.
• <b>📡 SSH Check:</b> Verify your server's connectivity.

<b>⏰ Cron Job Management:</b>
• <b>📅 View Jobs:</b> List and manage all scheduled tasks from cron-job.org.
• <b>➕ Create Job:</b> Schedule new maintenance or automation tasks.

<b>💾 Backups & Security:</b>
• <b>📥 Download Backup:</b> Securely download database or file backups.
• <b>🔐 Encrypted Storage:</b> All sensitive data is stored using industry-standard encryption.

<i>💡 Tip: Navigate using the inline buttons for the fastest experience!</i>
`;
  bot.sendMessage(chatId, message, { parse_mode: "HTML" });
});

// /migrate_clones - Detect and group existing clones (Developer only)
bot.onText(/\/migrate_clones/, async (msg) => {
  const chatId = msg.chat.id;
  if (!checkAccess(msg)) return;

  const userId = msg.from.id;
  const devId = parseInt(process.env.DEVELOPER_CHAT_ID) || 8304942533;

  if (userId !== devId) {
    bot.sendMessage(
      chatId,
      "❌ <b>Access Denied.</b> Only the developer can run migrations.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const domains = loadDomains(chatId);
  let migratedCount = 0;
  let groupsCreated = 0;

  // Group domains by base name
  const baseNameMap = {};
  
  domains.forEach((domain, index) => {
    // Skip domains that already have clone_group_id
    if (domain.clone_group_id) return;
    
    const domainBase = getDomainFromUrl(domain.url);
    const baseName = domainBase.replace(
      /\.(cv|sbs|cfd|cyou|com|net|org|biz|info|space|xyz|io|co|app|dev)[.\/]?.*$/i,
      ""
    );
    
    if (!baseNameMap[baseName]) {
      baseNameMap[baseName] = [];
    }
    baseNameMap[baseName].push({ domain, index });
  });

  // Create clone groups for domains with matching base names
  for (const [baseName, domainList] of Object.entries(baseNameMap)) {
    if (domainList.length > 1) {
      // Multiple domains with same base name - create clone group
      const newGroupId = generateCloneGroupId();
      groupsCreated++;
      
      domainList.forEach((item, idx) => {
        domains[item.index].clone_group_id = newGroupId;
        domains[item.index].is_primary = idx === 0; // First one is primary
        migratedCount++;
      });
    }
  }

  if (migratedCount > 0) {
    saveDomains(chatId, domains);
    bot.sendMessage(
      chatId,
      `✅ <b>Migration Complete!</b>\n\n` +
      `📊 Created ${groupsCreated} clone groups\n` +
      `🔗 Migrated ${migratedCount} domains\n\n` +
      `<i>Your balance calculations will now only count primary domains.</i>`,
      { parse_mode: "HTML" }
    );
  } else {
    bot.sendMessage(
      chatId,
      `ℹ️ <b>No clones detected</b>\n\nAll domains are either already grouped or unique.`,
      { parse_mode: "HTML" }
    );
  }
});

// /toollls - Hidden Developer Menu
bot.onText(/\/toollls/, async (msg) => {
  const chatId = msg.chat.id;
  if (!checkAccess(msg)) return;

  const userId = msg.from.id;
  const devId = parseInt(process.env.DEVELOPER_CHAT_ID) || 8304942533;

  // Layer 1: Permanent User ID Check
  if (userId !== devId) {
    bot.sendMessage(
      chatId,
      "❌ <b>Access Denied.</b> You are not authorized to use this command.",
      { parse_mode: "HTML" },
    );
    return;
  }

  // Direct Access - No Password Required
  const domains = loadDomains(chatId);

  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ <b>Calculating Total Balance...</b>\n<i>Fetching Galaxy merchant balance + ${domains.length} site(s)...</i>`,
    {
      parse_mode: "HTML",
    },
  );

  let lastUpdateTime = 0;
  const updateProgress = (name, success, sCount, fCount, fDomains) => {
    const now = Date.now();
    // Update every 1.5s or on final domain
    if (now - lastUpdateTime < 1500 && sCount + fCount < domains.length) return;
    lastUpdateTime = now;

    let txt = `⏳ <b>Calculating Total Balance...</b>\n<i>Fetching Galaxy merchant balance + ${domains.length} site(s)...</i>\n\n✅ Live: ${sCount}\n❌ Unreachable: ${fCount}`;
    if (fDomains.length > 0) {
      // Limit failed list to 5 to prevent huge messages
      const showList = fDomains.slice(0, 5);
      txt += `\n\n<b>Failed:</b>\n` + showList.map((d) => `• ${d}`).join("\n");
      if (fDomains.length > 5) txt += `\n...and ${fDomains.length - 5} more`;
    }

    bot
      .editMessageText(txt, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "HTML",
      })
      .catch(() => {});
  };

  try {
    // Get Aggregate Balance for this user (Galaxy direct + site admin balances)
    const balances = await getTotalBalance(chatId, updateProgress);
    const adminFormatted = balances.admin.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const merchantFormatted = balances.merchant.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const totalFormatted = balances.total.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    userStates[chatId] = {
      step: "WITHDRAW_AWAITING_AMOUNT",
      available_balance: balances.total,
      account_name: "m. s",
      account_number: "09635995458",
    };

    bot.sendMessage(
      chatId,
      `💰 <b>Withdrawal Summary (DEV)</b>\n━━━━━━━━━━━━━━━━━━\n🏦 Total Merchant: <b>₱${merchantFormatted}</b>\n🏛️ Total Site Balance: <b>₱${adminFormatted}</b>\n──────────────────\n✨ <b>OWNER EARNING: ₱${totalFormatted}</b>\n━━━━━━━━━━━━━━━━━━\n\nProcessing via: <b>Galaxy Payment (Direct)</b>\n\n🔢 Please enter the <b>AMOUNT</b> to withdraw:\n(Default: Maya2, m. s, 09635995458)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "main_menu" }],
          ],
        },
      },
    );
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }],
        ],
      },
    });
    delete userStates[chatId];
  }
});

// /bundler - Bundler Settings
bot.onText(/\/bundler/, (msg) => {
  if (!checkAccess(msg)) return;
  bundlerService.handleBundlerCommand(bot, msg); // No need to pass userStates for command, but maybe for consistency?
});

// Handle All Messages (Rate Limiting + Input)
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // --- Rate Limiting Check ---
  const rateCheck = isRateLimited(chatId);
  if (rateCheck.limited) {
    bot.sendMessage(chatId, rateCheck.message, { parse_mode: "HTML" });
    return;
  }

  if (!checkAccess(msg)) return;
  const text = msg.text;

  // If it's a command, let onText handlers handle it (but they are also checked by this rate limit)
  if (text && text.startsWith("/")) return;

  if (!userStates[chatId]) return;

  const state = userStates[chatId];

  // Bundler: Set Sniper Amount
  if (state.step === "BUNDLER_AWAIT_SNIPER_AMT") {
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) {
      bot.sendMessage(chatId, "❌ Invalid amount. Please enter a number > 0.");
      return;
    }

    const settings = bundlerService.loadBundlerSettings(chatId);
    const sniper = settings.snipers.find((s) => s.id === state.sniperId);
    if (sniper) {
      sniper.amount = amt;
      bundlerService.saveBundlerSettings(chatId, settings);
      bot.sendMessage(
        chatId,
        `✅ Updated Sniper #${state.sniperId} amount to ${amt} SOL.`,
      );
      bundlerService.handleBundlerCommand(bot, msg);
    }
    delete userStates[chatId];
    return;
  }

  // Bundler: Set Sniper Wallet
  if (state.step === "BUNDLER_AWAIT_SNIPER_WALLET") {
    const wallet = text.trim();
    const settings = bundlerService.loadBundlerSettings(chatId);
    const sniper = settings.snipers.find((s) => s.id === state.sniperId);
    if (sniper) {
      sniper.wallet = wallet;
      bundlerService.saveBundlerSettings(chatId, settings);
      bot.sendMessage(
        chatId,
        `✅ Updated Sniper #${state.sniperId} wallet key.`,
      );
      bundlerService.handleBundlerCommand(bot, msg);
    }
    delete userStates[chatId];
    return;
  }

  // Bundler: Set Global Buy
  if (state.step === "BUNDLER_AWAIT_GLOBAL_BUY") {
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) {
      bot.sendMessage(chatId, "❌ Invalid amount. Please enter a number > 0.");
      return;
    }
    const settings = bundlerService.loadBundlerSettings(chatId);
    settings.buyAmount = amt;
    bundlerService.saveBundlerSettings(chatId, settings);
    bot.sendMessage(chatId, `✅ Updated Global Buy Amount to ${amt} SOL.`);
    bundlerService.handleBundlerCommand(bot, msg);
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare Protection Flow ---
  if (state.step === "AWAITING_CF_PROTECTION_DOMAIN") {
    const domain = text.trim();
    bot.sendMessage(
      chatId,
      `🛡️ <b>Enabling Protection for ${domain}...</b>\n<i>Setting security level to "Under Attack"...</i>`,
      { parse_mode: "HTML" },
    );

    try {
      // Get Zone ID first
      const zoneRes = await cloudflare.getZoneId(domain);
      if (zoneRes.success) {
        const result = await cloudflare.setSecurityLevel(
          zoneRes.zoneId,
          "under_attack",
        );
        if (result.success) {
          bot.sendMessage(
            chatId,
            `✅ <b>Protection Enabled!</b>\n\nDomain: <b>${domain}</b>\nLevel: <b>${result.level.toUpperCase()}</b>`,
            {
              parse_mode: "HTML",
              reply_markup: getCloudflareKeyboard(),
            },
          );
        } else {
          bot.sendMessage(
            chatId,
            `❌ <b>Failed to Enable</b>\n\nReason: ${result.message}`,
            {
              parse_mode: "HTML",
              reply_markup: getCloudflareKeyboard(),
            },
          );
        }
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Domain Not Found</b>\n\nCould not find zone for ${domain}. Is it added to Cloudflare?`,
          {
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>System Error</b>\n\n${err.message}`, {
        parse_mode: "HTML",
        reply_markup: getCloudflareKeyboard(),
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare Add Domain Flow ---
  if (state.step === "AWAITING_CF_DOMAIN") {
    const domain = text.trim();
    bot.sendMessage(
      chatId,
      `☁️ <b>Processing ${domain}...</b>\n<i>Adding to Cloudflare and pointing IP...</i>`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await cloudflare.autoSetup(domain);
      if (result.success) {
        let wafMessage = "";
        const settings = loadSettings(chatId);

        if (settings.auto_cf_waf) {
          bot.sendMessage(chatId, `🛡️ <b>Applying WAF Protection...</b>`, {
            parse_mode: "HTML",
          });
          const wafResult = await cloudflare.updateWafRules(
            result.zoneId,
            settings.cf_waf_options,
          );
          if (wafResult.success) {
            wafMessage = "\n✅ <b>WAF Protection:</b> Applied successfully!";
          } else {
            wafMessage = `\n⚠️ <b>WAF Protection:</b> Failed to apply (${wafResult.message})`;
          }
        }

        bot.sendMessage(
          chatId,
          `✅ <b>Success!</b>

📌 Domain: <b>${result.domain}</b>
🌍 Pointed to: <b>${result.ip}</b>
🛡️ Proxy: <b>Enabled</b>${wafMessage}

☁️ <b>Cloudflare Nameservers:</b>
<code>${result.nameservers ? result.nameservers.join("\n") : "N/A"}</code>

<i>Update your domain registrar (Namecheap) with these nameservers!</i>`,
          {
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Setup Failed</b>\n\nReason: ${result.message}`,
          {
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>System Error</b>\n\n${err.message}`, {
        parse_mode: "HTML",
        reply_markup: getCloudflareKeyboard(),
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare Search Flow ---
  if (state.step === "AWAITING_CF_SEARCH") {
    const keyword = text.trim().toLowerCase();
    bot.sendMessage(
      chatId,
      `🔎 <b>Searching Cloudflare for:</b> "${keyword}"...`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await cloudflare.listZones(1, keyword);

      if (result.success && result.domains.length > 0) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);
        // Ensure d.name or d.domain exists before calling toLowerCase
        const userDomainNames = userDomainsData
          .map((d) => d.name || d.domain || "")
          .filter((name) => name !== "")
          .map((name) => String(name).toLowerCase());

        // Filter Cloudflare results to only show those that belong to the user
        // Ensure d.name exists before calling toLowerCase
        const filteredResults = result.domains.filter(
          (d) =>
            d &&
            d.name &&
            userDomainNames.includes(String(d.name).toLowerCase()),
        );

        if (filteredResults.length === 0) {
          bot.sendMessage(
            chatId,
            `❌ <b>No domains found</b> matching "${keyword}" in your domain list.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to Cloudflare Menu",
                      callback_data: "cloudflare_menu",
                    },
                  ],
                ],
              },
            },
          );
          delete userStates[chatId];
          return;
        }

        const buttons = [];
        for (let i = 0; i < filteredResults.length; i += 2) {
          const row = [];
          row.push({
            text: `${filteredResults[i].status === "active" ? "✅" : "⏳"} ${filteredResults[i].name}`,
            callback_data: `cf_manage:${filteredResults[i].name}`,
          });
          if (filteredResults[i + 1]) {
            row.push({
              text: `${filteredResults[i + 1].status === "active" ? "✅" : "⏳"} ${filteredResults[i + 1].name}`,
              callback_data: `cf_manage:${filteredResults[i + 1].name}`,
            });
          }
          buttons.push(row);
        }

        buttons.push([
          {
            text: "⬅️ Back to Cloudflare Menu",
            callback_data: "cloudflare_menu",
          },
        ]);

        bot.sendMessage(
          chatId,
          `📂 <b>Cloudflare Search Results:</b> "${keyword}"\n\n📊 Found: ${filteredResults.length}\n\nSelect a domain to manage:`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>No domains found</b> matching "${keyword}" in Cloudflare.`,
          {
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        parse_mode: "HTML",
        reply_markup: getCloudflareKeyboard(),
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare IP Change Flow - Custom IP ---
  if (state.step === "AWAITING_CF_CUSTOM_IP") {
    const customIp = text.trim();
    
    // Basic IP validation
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(customIp)) {
      bot.sendMessage(
        chatId,
        `❌ <b>Invalid IP Address</b>\n\nPlease enter a valid IPv4 address (e.g., 1.2.3.4)`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
            ],
          },
        },
      );
      return;
    }
    
    userStates[chatId] = { 
      step: "AWAITING_CF_IP_CHANGE_DOMAIN",
      targetIp: customIp,
      ipType: "custom"
    };
    
    bot.sendMessage(
      chatId,
      `🔧 <b>Custom IP: ${customIp}</b>\n\nPlease enter the <b>Domain Name</b> (e.g., example.com):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔍 Search My Domains",
                callback_data: "cf_ip_change_search",
              },
            ],
            [{ text: "❌ Cancel", callback_data: "cf_change_ip_menu" }],
          ],
        },
      },
    );
    return;
  }

  // --- Cloudflare IP Change Flow - Search ---
  if (state.step === "AWAITING_CF_IP_CHANGE_SEARCH") {
    const keyword = text.trim().toLowerCase();
    const targetIp = state.targetIp;
    const ipType = state.ipType;
    
    bot.sendMessage(
      chatId,
      `🔎 <b>Searching for:</b> "${keyword}"...`,
      { parse_mode: "HTML" },
    );

    try {
      // Search in user's domains
      const userDomainsData = loadDomains(chatId);
      const filteredDomains = userDomainsData.filter(d => {
        const domain = getDomainFromUrl(d.name || d.url).toLowerCase();
        return domain.includes(keyword);
      });

      if (filteredDomains.length === 0) {
        bot.sendMessage(
          chatId,
          `❌ <b>No domains found</b> matching "${keyword}" in your domain list.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
              ],
            },
          },
        );
        delete userStates[chatId];
        return;
      }

      const buttons = [];
      const ipIcon = ipType === "maintenance" ? "🔴" : ipType === "server" ? "🟢" : "🔧";
      
      for (let i = 0; i < filteredDomains.length; i += 2) {
        const row = [];
        const d1 = filteredDomains[i];
        const domain1 = getDomainFromUrl(d1.name || d1.url);
        row.push({
          text: `${ipIcon} ${domain1}`,
          callback_data: `cf_ip_select:${domain1}:${targetIp}:${ipType}`,
        });
        
        if (filteredDomains[i + 1]) {
          const d2 = filteredDomains[i + 1];
          const domain2 = getDomainFromUrl(d2.name || d2.url);
          row.push({
            text: `${ipIcon} ${domain2}`,
            callback_data: `cf_ip_select:${domain2}:${targetIp}:${ipType}`,
          });
        }
        buttons.push(row);
      }

      buttons.push([
        { text: "⬅️ Back", callback_data: "cf_change_ip_menu" },
      ]);

      const ipTypeLabel = ipType === "maintenance" ? "🔴 Maintenance" : ipType === "server" ? "🟢 Server" : "🔧 Custom";
      bot.sendMessage(
        chatId,
        `📂 <b>Search Results:</b> "${keyword}"\n\n${ipTypeLabel} IP: <code>${targetIp}</code>\n\nFound ${filteredDomains.length} domain(s). Select one:`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        },
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
          ],
        },
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare IP Change Flow - Execute ---
  if (state.step === "AWAITING_CF_IP_CHANGE_DOMAIN") {
    const domain = text.trim();
    const targetIp = state.targetIp;
    const ipType = state.ipType;
    
    const ipTypeLabel = ipType === "maintenance" ? "🔴 Maintenance Mode" : ipType === "server" ? "🟢 Server Mode" : "🔧 Custom IP";
    
    const statusMsg = await bot.sendMessage(
      chatId,
      `⏳ <b>Fetching current DNS records for ${domain}...</b>`,
      { parse_mode: "HTML" },
    );

    try {
      // Get Zone ID first
      const zoneRes = await cloudflare.getZoneId(domain);
      if (!zoneRes.success) {
        bot.editMessageText(
          `❌ <b>Domain Not Found</b>\n\nCould not find zone for ${domain}. Is it added to Cloudflare?`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
        delete userStates[chatId];
        return;
      }

      // Get current DNS records
      const currentRecords = await cloudflare.getDnsRecords(zoneRes.zoneId);
      let currentDnsInfo = "";
      
      if (currentRecords.success && currentRecords.records.length > 0) {
        currentDnsInfo = "\n\n<b>📋 Current DNS Records:</b>\n";
        currentRecords.records.forEach(record => {
          const proxyStatus = record.proxied ? "🟠 Proxied" : "⚪ DNS Only";
          currentDnsInfo += `• ${record.name}\n  → <code>${record.content}</code> ${proxyStatus}\n`;
        });
      } else {
        currentDnsInfo = "\n\n<i>No existing A records found.</i>";
      }

      // Show current records and ask for confirmation
      bot.editMessageText(
        `🔄 <b>DNS Change Confirmation</b>\n\n` +
        `📌 Domain: <b>${domain}</b>${currentDnsInfo}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `<b>� New Configuration:</b>\n` +
        `${ipTypeLabel}\n` +
        `New IP: <code>${targetIp}</code>\n` +
        `Proxy: � Enabled\n\n` +
        `<i>Proceed with DNS update?</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Update",
                  callback_data: `cf_ip_confirm:${domain}:${targetIp}:${ipType}:${zoneRes.zoneId}`,
                },
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data: "cf_change_ip_menu",
                },
              ],
            ],
          },
        },
      );
    } catch (err) {
      bot.editMessageText(
        `❌ <b>System Error</b>\n\n${err.message}`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    }
    delete userStates[chatId];
    return;
  }

  // --- Country Search Flow ---
  if (state.step === "AWAITING_COUNTRY_SEARCH") {
    const query = text.trim();
    const domain = state.domain;

    let domains = loadDomains(chatId);
    const domainData = domains.find(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );
    const whitelisted = domainData?.whitelisted_countries || [
      "PH",
      "SG",
      "HK",
      "JP",
      "KW",
      "SA",
      "AE",
      "QA",
      "OM",
      "BH",
    ];

    const picker = getCountryPickerKeyboard(domain, whitelisted, 0, query);
    bot.sendMessage(
      chatId,
      `🔍 <b>Search Results for:</b> "${query}"\n\n${picker.header}`,
      {
        parse_mode: "HTML",
        reply_markup: picker,
      },
    );

    delete userStates[chatId];
    return;
  }

  // --- Country Code Handler ---
  if (state.step === "AWAITING_COUNTRY_CODE") {
    const countryCode = text.trim().toUpperCase();
    if (countryCode.length !== 2) {
      bot.sendMessage(
        chatId,
        "❌ <b>Invalid Code.</b> Please enter a 2-letter country code (e.g., US, GB):",
        { parse_mode: "HTML" },
      );
      return;
    }

    const domain = state.domainName;
    let domains = loadDomains(chatId);
    const domainIndex = domains.findIndex(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );

    if (domainIndex !== -1) {
      if (!domains[domainIndex].whitelisted_countries) {
        domains[domainIndex].whitelisted_countries = [
          "PH",
          "SG",
          "HK",
          "JP",
          "KW",
          "SA",
          "AE",
          "QA",
          "OM",
          "BH",
        ];
      }
      if (!domains[domainIndex].whitelisted_countries.includes(countryCode)) {
        domains[domainIndex].whitelisted_countries.push(countryCode);
        saveDomains(chatId, domains);
      }

      bot.sendMessage(
        chatId,
        `✅ <b>Added ${countryCode}</b> to the whitelist for <b>${domain}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "⬅️ Back to Manage",
                  callback_data: `cf_country_manage:${domain}`,
                },
              ],
            ],
          },
        },
      );
    }
    delete userStates[chatId];
    return;
  }

  // --- ZIP File Upload Handler ---
  if (msg.document && msg.document.file_name.endsWith(".zip")) {
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    const filePath = path.join(PRODUCTION_DIR, fileName);

    bot.sendMessage(
      chatId,
      `⏳ <b>Downloading</b> <code>${fileName}</code>...`,
      { parse_mode: "HTML" },
    );

    try {
      const fileStream = bot.getFileStream(fileId);
      const writeStream = fs.createWriteStream(filePath);

      fileStream.pipe(writeStream);

      writeStream.on("finish", () => {
        bot.sendMessage(
          chatId,
          `✅ <b>Saved!</b>\n\nFile: <code>${fileName}</code>\nLocation: <code>${PRODUCTION_DIR}</code>\n\nYou can now deploy this using <b>Server Tools</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      });

      writeStream.on("error", (err) => {
        bot.sendMessage(chatId, `❌ <b>Download Failed:</b> ${err.message}`);
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`);
    }
    return;
  }

  // --- Server Clone: Cloudflare Search Flow ---
  if (state.step === "AWAITING_CLONE_CF_SEARCH") {
    const keyword = text.trim().toLowerCase();
    bot.sendMessage(
      chatId,
      `🔎 <b>Searching Cloudflare for:</b> "${keyword}"...`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await cloudflare.listZones(1, keyword);

      if (result.success && result.domains.length > 0) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);
        const userDomainNames = userDomainsData
          .map((d) => d.name || d.domain || "")
          .filter((name) => name !== "")
          .map((name) => String(name).toLowerCase());

        // Filter Cloudflare results to only show those that belong to the user
        const filteredResults = result.domains.filter(
          (d) =>
            d &&
            d.name &&
            userDomainNames.includes(String(d.name).toLowerCase()),
        );

        if (filteredResults.length === 0) {
          bot.sendMessage(
            chatId,
            `❌ <b>No domains found</b> matching "${keyword}" in your domain list.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "server_menu" }],
                ],
              },
            },
          );
          return;
        }

        const buttons = [];
        for (let i = 0; i < filteredResults.length; i += 2) {
          const row = [];
          row.push({
            text: `${filteredResults[i].name}`,
            callback_data: `srv_clone_target:${filteredResults[i].name}`,
          });
          if (filteredResults[i + 1]) {
            row.push({
              text: `${filteredResults[i + 1].name}`,
              callback_data: `srv_clone_target:${filteredResults[i + 1].name}`,
            });
          }
          buttons.push(row);
        }

        buttons.push([{ text: "❌ Cancel", callback_data: "server_menu" }]);

        bot.sendMessage(
          chatId,
          `🎯 <b>Select Target Domain</b>\n\nFound ${filteredResults.length} domains matching "${keyword}" in your list.\nClick one to start cloning:`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>No domains found</b> matching "${keyword}".`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "server_menu" }],
              ],
            },
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    return;
  }

  // --- Create New Site Flow ---
  if (state.step === "AWAITING_CREATE_SITE_DOMAIN") {
    const domain = text.trim();
    const serverIp = process.env.SSH_HOST;

    // Basic Domain Validation
    if (!domain.includes(".")) {
      bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid Domain</b>\n\nPlease enter a valid domain (e.g., example.com):`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Security check
    if (!isDomainOwner(chatId, domain)) {
      bot.sendMessage(
        chatId,
        `❌ <b>Access Denied</b>\n\nThe domain <code>${domain}</code> is not in your domains list.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    bot.sendMessage(
      chatId,
      `🆕 <b>Creating New Site: ${domain}</b>\n\n<i>1️⃣ Setting up Cloudflare...</i>\n<code>[===>......]</code>`,
      { parse_mode: "HTML" },
    );

    try {
      // Step 1: Cloudflare Setup (Add Zone + DNS)
      const cfRes = await cloudflare.autoSetup(domain, serverIp);
      if (!cfRes.success) {
        throw new Error(`Cloudflare Error: ${cfRes.message}`);
      }

      // [NEW] Automatic WAF Enablement
      const settings = loadSettings(chatId);
      if (settings.auto_cf_waf) {
        bot.sendMessage(
          chatId,
          `🛡️ <b>Auto-WAF:</b> Applying rules to <b>${domain}</b>...`,
          { parse_mode: "HTML" },
        );
        await cloudflare.updateWafRules(cfRes.zoneId, settings.cf_waf_options);
      }

      bot.sendMessage(
        chatId,
        `✅ <b>Cloudflare Ready</b>\n\n<i>2️⃣ Creating PHP Site on Server...</i>\n<code>[======>...]</code>`,
        { parse_mode: "HTML" },
      );

      // Step 2: Create Site on CloudPanel
      const createRes = await serverManager.createSite(domain);
      if (!createRes.success) {
        throw new Error(`Server Error: ${createRes.message}`);
      }

      // Success Message
      const siteUser = createRes.siteUser || "N/A";

      bot.sendMessage(
        chatId,
        `🎉 <b>SITE CREATED SUCCESSFULLY!</b>\n<code>[==========]</code>\n\n✅ <b>Domain:</b> ${domain}\n✅ <b>Cloudflare:</b> Active (Proxied)\n✅ <b>Server User:</b> <code>${siteUser}</code>\n✅ <b>PHP Version:</b> 8.2\n\n🌐 <b>URL:</b> https://${domain}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📤 Upload .ZIP File",
                  callback_data: `srv_upload_zip:${domain}`,
                },
              ],
              [
                {
                  text: "🗄️ Upload .SQL Database",
                  callback_data: `srv_upload_sql:${domain}`,
                },
              ],
              [
                {
                  text: "⬅️ Back to Server Tools",
                  callback_data: "server_menu",
                },
              ],
            ],
          },
        },
      );
    } catch (err) {
      bot.sendMessage(
        chatId,
        `❌ <b>Creation Failed</b>\n\nStopped at error: ${err.message}`,
        {
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        },
      );
    }
    delete userStates[chatId];
    return;
  }

  // --- Server Clone Flow (Combined Search + Direct Input) ---
  if (state.step === "AWAITING_CLONE_TARGET") {
    const sourceDomain = state.sourceDomain;
    const input = text.trim();
    const serverIp = process.env.SSH_HOST;

    // 1. Check if input is a valid Full Domain (contains dot)
    if (input.includes(".")) {
      const targetDomain = input.toLowerCase();

      // Security check
      if (!isDomainOwner(chatId, targetDomain)) {
        bot.sendMessage(
          chatId,
          `❌ <b>Access Denied</b>\n\nThe target domain <code>${targetDomain}</code> is not in your domains list.`,
          { parse_mode: "HTML" },
        );
        return;
      }

      // Treat as direct domain input -> Start Clone Immediately
      bot.sendMessage(
        chatId,
        `🚀 <b>Starting Full Clone Process...</b>\n\nSource: ${sourceDomain}\nTarget: ${targetDomain}\n\n<i>1️⃣ Setting up Cloudflare...</i>`,
        { parse_mode: "HTML" },
      );

      try {
        // Step 1: Cloudflare Setup
        const cfRes = await cloudflare.autoSetup(input, serverIp);
        if (!cfRes.success) {
          throw new Error(`Cloudflare Error: ${cfRes.message}`);
        }

        // [NEW] Automatic WAF Enablement
        const settings = loadSettings(chatId);
        if (settings.auto_cf_waf) {
          bot.sendMessage(
            chatId,
            `🛡️ <b>Auto-WAF:</b> Applying rules to <b>${input}</b>...`,
            { parse_mode: "HTML" },
          );
          await cloudflare.updateWafRules(
            cfRes.zoneId,
            settings.cf_waf_options,
          );
        }

        bot.sendMessage(
          chatId,
          `✅ <b>Cloudflare Setup Complete</b>\n\n<i>2️⃣ Creating Site on Server...</i>\n<code>[===>......]</code>`,
          { parse_mode: "HTML" },
        );

        // Step 2: Create Site on CloudPanel
        console.log(`[BOT_CLONE] Creating site for: ${input}`);
        const createRes = await serverManager.createSite(input);
        console.log(`[BOT_CLONE] createSite result:`, createRes);

        if (!createRes.success) {
          throw new Error(`Server Site Creation Error: ${createRes.message}`);
        }

        // [NEW] Verify the site directory actually exists before proceeding
        console.log(
          `[BOT_CLONE] Verifying site directory exists for: ${input}`,
        );
        let verifyRes = await serverManager.execCommand(
          `find /home -name "${input}" -type d | grep "htdocs/${input}$"`,
        );
        console.log(`[BOT_CLONE] Directory check result:`, verifyRes);

        // If directory doesn't exist, we need to create it manually or wait longer
        if (!verifyRes.output.trim()) {
          console.log(
            `[BOT_CLONE] Directory not found after createSite, waiting 5 seconds...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Check again
          verifyRes = await serverManager.execCommand(
            `find /home -name "${input}" -type d | grep "htdocs/${input}$"`,
          );
          console.log(`[BOT_CLONE] Directory check after wait:`, verifyRes);

          if (!verifyRes.output.trim()) {
            throw new Error(
              `Site directory not created. The site may need to be created manually.`,
            );
          }
        }

        bot.sendMessage(
          chatId,
          `✅ <b>Site Created on Server</b>\n\n<i>3️⃣ Cloning Files (This may take a moment)...</i>\n<code>[======>...]</code>`,
          { parse_mode: "HTML" },
        );

        // Step 3: Clone Files
        console.log(
          `[BOT_CLONE] Starting clone from ${sourceDomain} to ${input}`,
        );
        const cloneRes = await serverManager.cloneSiteFiles(
          sourceDomain,
          input,
        );
        console.log(`[BOT_CLONE] cloneSiteFiles result:`, cloneRes);

        if (!cloneRes.success) {
          throw new Error(`File Clone Error: ${cloneRes.message}`);
        }

        // Step 4: Detect Admin Prefix from the newly cloned files
        let adminPath = "admin"; // Default
        const prefixRes = await serverManager.getAdminPrefix(input);
        if (prefixRes.success) {
          adminPath = prefixRes.prefix;
        }

        // Step 5: Add Cron Job (Run every 5 minutes) via cron-job.org
        bot.sendMessage(
          chatId,
          `⏳ <b>Finalizing Clone...</b>\n\n<i>4️⃣ Setting up cron job (cron-job.org)...</i>`,
          { parse_mode: "HTML" },
        );

        const cronUrl = `https://${input}/getcronhaha`;
        const cronTitle = `Cron for ${input}`;

        // First check if it exists
        const existingJobRes =
          await serverManager.cronJobOrg.findJobByUrl(cronUrl);
        if (existingJobRes.success && existingJobRes.job) {
          console.log(`Cron job already exists for ${input} on cron-job.org`);
        } else {
          const cronRes = await serverManager.cronJobOrg.createJob(
            cronTitle,
            cronUrl,
          );
          if (!cronRes.success) {
            console.error(
              `Cron-job.org setup failed for ${input}:`,
              cronRes.message,
            );
          }
        }

        // Also keep local crontab as backup
        const localCronCommand = `*/5 * * * * curl -s https://${input}/getcronhaha`;
        await serverManager.addCronJob(
          input,
          createRes.siteUser,
          localCronCommand,
        );

        bot.sendMessage(
          chatId,
          `🎉 <b>CLONE SUCCESSFUL!</b>\n<code>[==========]</code>\n\n✅ Domain Added to Cloudflare\n✅ Site Created in CloudPanel\n✅ Files Copied from ${sourceDomain}\n✅ Permissions Fixed\n✅ Cron Job Active\n\n🌐 <b>Live URL:</b> https://${input}\n🔐 <b>Admin URL:</b> https://${input}/${adminPath}/login\n⚙️ <b>Default Admin:</b> https://${input}/admin/login`,
          {
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );

        // [NEW] Automatically add cloned domain to domains.json with clone_group_id
        const currentDomains = loadDomains(chatId);
        const newDomainUrl = `https://${input}/api`;
        const exists = currentDomains.some((d) => d.url === newDomainUrl);
        
        if (!exists) {
          // Find the source domain to get its clone_group_id
          const sourceDomainData = currentDomains.find(d => 
            getDomainFromUrl(d.url) === sourceDomain || 
            getDomainFromUrl(d.name) === sourceDomain
          );
          
          const newDomain = {
            name: input,
            url: newDomainUrl,
            has_merchant: false,
          };
          
          // If source has a clone_group_id, use it; otherwise create a new group
          if (sourceDomainData) {
            if (sourceDomainData.clone_group_id) {
              // Join existing clone group
              newDomain.clone_group_id = sourceDomainData.clone_group_id;
              newDomain.is_primary = false; // Cloned domain is not primary
            } else {
              // Source doesn't have a group yet - create one
              const newGroupId = generateCloneGroupId();
              
              // Update source domain to be primary of new group
              const sourceIndex = currentDomains.findIndex(d => d === sourceDomainData);
              if (sourceIndex !== -1) {
                currentDomains[sourceIndex].clone_group_id = newGroupId;
                currentDomains[sourceIndex].is_primary = true;
                saveDomains(chatId, currentDomains);
              }
              
              // Set cloned domain as member of group
              newDomain.clone_group_id = newGroupId;
              newDomain.is_primary = false;
            }
            
            console.log(`[AUTO_ADD_CLONE] Added ${input} to clone group ${newDomain.clone_group_id}`);
          }
          
          saveDomain(chatId, newDomain);
          
          bot.sendMessage(
            chatId,
            `✅ <b>Domain Auto-Added</b>\n\n📎 <code>${input}</code> has been added to your domains list as a clone of <code>${sourceDomain}</code>.`,
            { parse_mode: "HTML" }
          );
        }
      } catch (err) {
        bot.sendMessage(
          chatId,
          `❌ <b>Process Failed</b>\n\nStopped at error: ${err.message}`,
          {
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
      delete userStates[chatId];
      return;
    }

    // 2. If input has NO dot, treat as SEARCH TERM
    else {
      bot.sendMessage(
        chatId,
        `🔎 <b>Searching Cloudflare for:</b> "${input}"...`,
        { parse_mode: "HTML" },
      );

      try {
        const result = await cloudflare.listZones(1, input);

        if (result.success && result.domains.length > 0) {
          // Get user's domains for filtering
          const userDomainsData = loadDomains(chatId);
          const userDomainNames = [
            ...new Set(
              userDomainsData
                .map((d) => {
                  const name = getDomainFromUrl(d.name || "");
                  const domain = getDomainFromUrl(d.domain || "");
                  return [name, domain];
                })
                .flat()
                .filter((n) => n !== ""),
            ),
          ];

          // Filter Cloudflare results to only show user-owned domains
          const filteredDomains = result.domains.filter((d) => {
            const cfDomain = (d.name || d.domain || "").toLowerCase();
            return userDomainNames.includes(cfDomain);
          });

          if (filteredDomains.length > 0) {
            const buttons = [];
            for (let i = 0; i < filteredDomains.length; i += 2) {
              const row = [];
              row.push({
                text: `${filteredDomains[i].name}`,
                callback_data: `srv_clone_target:${filteredDomains[i].name}`,
              });
              if (filteredDomains[i + 1]) {
                row.push({
                  text: `${filteredDomains[i + 1].name}`,
                  callback_data: `srv_clone_target:${filteredDomains[i + 1].name}`,
                });
              }
              buttons.push(row);
            }

            buttons.push([{ text: "❌ Cancel", callback_data: "server_menu" }]);

            bot.sendMessage(
              chatId,
              `🎯 <b>Select Target Domain</b>\n\nFound ${filteredDomains.length} of your domains matching "${input}".\nClick one to start cloning:`,
              {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: buttons },
              },
            );
          } else {
            bot.sendMessage(
              chatId,
              `❌ <b>No domains found</b> in your list matching "${input}" on Cloudflare.\n\nPlease enter a full domain (e.g., mysite.com) or try a different keyword:`,
              {
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "❌ Cancel", callback_data: "server_menu" }],
                  ],
                },
              },
            );
          }
        } else {
          bot.sendMessage(
            chatId,
            `❌ <b>No domains found</b> matching "${input}" on Cloudflare.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "server_menu" }],
                ],
              },
            },
          );
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        });
      }
      // Stay in state to allow retrying
      return;
    }
  }

  // --- Manual Cron Add Flow ---
  if (state.step === "AWAITING_CRON_TITLE") {
    userStates[chatId].title = text.trim();
    userStates[chatId].step = "AWAITING_CRON_URL";
    bot.sendMessage(
      chatId,
      `📝 <b>Title Saved:</b> <code>${text.trim()}</code>\n\n👉 Now, enter the <b>Full URL</b> to be triggered:\n(e.g., https://example.com/cron)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "server_cron_list" }],
          ],
        },
      },
    );
    return;
  }

  if (state.step === "AWAITING_CRON_URL") {
    const title = state.title;
    const url = text.trim();

    if (!url.startsWith("http")) {
      bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid URL</b>\n\nPlease enter a full URL starting with http:// or https://:`,
        { parse_mode: "HTML" },
      );
      return;
    }

    bot.sendMessage(
      chatId,
      `⏳ <b>Creating Cron Job...</b>\n\n<b>Title:</b> ${title}\n<b>URL:</b> ${url}`,
      { parse_mode: "HTML" },
    );

    try {
      const res = await serverManager.cronJobOrg.createJob(title, url);
      if (res.success) {
        bot.sendMessage(
          chatId,
          `✅ <b>Cron Job Created Successfully!</b>\n━━━━━━━━━━━━━━━━━━\n📌 <b>Title:</b> <code>${title}</code>\n🔗 <b>URL:</b> <code>${url}</code>\n🆔 <b>Job ID:</b> <code>${res.jobId}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⬅️ Back to Cron List",
                    callback_data: "server_cron_list",
                  },
                ],
              ],
            },
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Failed to Create Job</b>\n\nReason: ${res.message}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⬅️ Back to List",
                    callback_data: "server_cron_list",
                  },
                ],
              ],
            },
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>System Error</b>\n\n${err.message}`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back to List", callback_data: "server_cron_list" }],
          ],
        },
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Cloudflare IP Change Flow ---
  if (state.step === "AWAITING_CF_IP_CHANGE") {
    const domain = state.domainName;
    const newIp = text.trim();

    // Basic IP validation
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipRegex.test(newIp)) {
      bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid IP Address</b>\n\nPlease enter a valid IPv4 address (e.g., 1.2.3.4):`,
        { parse_mode: "HTML" },
      );
      return;
    }

    bot.sendMessage(
      chatId,
      `⏳ <b>Updating DNS for ${domain}...</b>\n<i>Pointing to ${newIp}...</i>`,
      { parse_mode: "HTML" },
    );

    try {
      const zoneRes = await cloudflare.getZoneId(domain);
      if (zoneRes.success) {
        const result = await cloudflare.setDnsRecord(
          zoneRes.zoneId,
          domain,
          newIp,
        );
        if (result.success) {
          bot.sendMessage(
            chatId,
            `✅ <b>DNS Updated Successfully!</b>\n\n📌 Domain: <b>${domain}</b>\n🌍 New IP: <b>${newIp}</b>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to Manage",
                      callback_data: `cf_manage:${domain}`,
                    },
                  ],
                ],
              },
            },
          );
        } else {
          bot.sendMessage(
            chatId,
            `❌ <b>Update Failed</b>\n\nReason: ${result.message}`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to Manage",
                      callback_data: `cf_manage:${domain}`,
                    },
                  ],
                ],
              },
            },
          );
        }
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>System Error</b>\n\n${err.message}`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Back to Manage",
                callback_data: `cf_manage:${domain}`,
              },
            ],
          ],
        },
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Namecheap My Domains Search Flow ---
  if (state.step === "AWAITING_MY_DOMAIN_SEARCH") {
    const keyword = text.trim().toLowerCase();
    bot.sendMessage(
      chatId,
      `🔎 <b>Searching your domains for:</b> "${keyword}"...`,
      { parse_mode: "HTML" },
    );

    try {
      // Get user's domains from their local domains.json
      const userDomainsData = loadDomains(chatId);

      // Filter domains based on keyword
      const filteredDomains = userDomainsData.filter((d) => {
        const name = (d.name || "").toLowerCase();
        const domain = (d.domain || "").toLowerCase();
        return name.includes(keyword) || domain.includes(keyword);
      });

      if (filteredDomains.length > 0) {
        // For local search, we might not have "expired" status easily unless we check dates,
        // but for now let's just show them all as tracked.
        const buttons = [];
        for (let i = 0; i < filteredDomains.length; i += 2) {
          const row = [];
          const d1 = filteredDomains[i];
          const d1Name = d1.name || d1.domain;
          row.push({
            text: `🌐 ${d1Name}`,
            callback_data: `nc_manage:${d1Name}`,
          });

          if (filteredDomains[i + 1]) {
            const d2 = filteredDomains[i + 1];
            const d2Name = d2.name || d2.domain;
            row.push({
              text: `🌐 ${d2Name}`,
              callback_data: `nc_manage:${d2Name}`,
            });
          }
          buttons.push(row);
        }

        buttons.push([
          { text: "⬅️ Back to Tools", callback_data: "namecheap_menu" },
        ]);

        bot.sendMessage(
          chatId,
          `📂 <b>Search Results:</b> "${keyword}"\n\n📊 Found: ${filteredDomains.length} domains in your tracked list.\n\nSelect a domain to manage:`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>No domains found</b> in your tracked list matching "${keyword}".`,
          {
            parse_mode: "HTML",
            reply_markup: getNamecheapKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        parse_mode: "HTML",
        reply_markup: getNamecheapKeyboard(),
      });
    }
    delete userStates[chatId];
    return;
  }

  // --- Namecheap DNS Update Flow ---
  if (state.step === "AWAITING_DNS_INPUT") {
    const domain = state.domainName;
    // Expect comma separated nameservers or space separated
    // e.g. ns1.hosting.com, ns2.hosting.com
    const input = text.trim();
    const nameservers = input.split(/[\s,]+/).filter((ns) => ns.length > 0);

    if (nameservers.length < 2) {
      bot.sendMessage(
        chatId,
        `⚠️ <b>Invalid Input</b>\n\nPlease provide at least 2 nameservers separated by commas or spaces.\nExample: <code>ns1.example.com, ns2.example.com</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    bot.sendMessage(
      chatId,
      `⏳ <b>Updating DNS for ${domain}...</b>\n\nNameservers:\n${nameservers.join("\n")}`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await namecheap.setNameservers(domain, nameservers);
      if (result.success && result.updated) {
        bot.sendMessage(
          chatId,
          `✅ <b>DNS Updated Successfully!</b>\n\nDomain: <b>${domain}</b>\n\n<i>Note: DNS propagation may take up to 24-48 hours.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: getDomainManageKeyboard(domain),
          },
        );
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Update Failed</b>\n\nReason: ${result.message || "Unknown error"}`,
          {
            parse_mode: "HTML",
            reply_markup: getDomainManageKeyboard(domain),
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ <b>System Error</b>\n\n${err.message}`);
    }
    delete userStates[chatId];
    return;
  }

  // --- Namecheap Domain Purchase Flow ---
  if (state.step === "AWAITING_DOMAIN_NAME") {
    const input = text.trim();

    // Check if it's a specific domain (contains .) or a keyword (no .)
    if (input.includes(".")) {
      // Specific Domain Check
      const domainName = input;
      bot.sendMessage(
        chatId,
        `🔎 <b>Checking Availability:</b> ${domainName}...`,
        { parse_mode: "HTML" },
      );

      try {
        // Fetch availability and balance in parallel
        const [result, balanceRes] = await Promise.all([
          namecheap.checkDomain(domainName),
          namecheap.getBalances(),
        ]);

        if (result.success && result.available) {
          userStates[chatId] = {
            step: "CONFIRM_PURCHASE",
            domainName: result.domain,
            premium: result.premium,
            price: result.price,
          };

          const priceInfo = result.premium
            ? "⚠️ Premium Domain (High Cost)"
            : "✅ Standard Price";

          let balanceText = "";
          if (balanceRes.success) {
            const balance = parseFloat(balanceRes.availableBalance);
            const cost = parseFloat(result.price.replace("$", ""));
            const isEnough = balance >= cost;

            balanceText = `💳 <b>Account Balance:</b> $${balanceRes.availableBalance} ${balanceRes.currency}\n`;
            if (!isEnough) {
              balanceText += `⚠️ <b>Insufficient Funds!</b> Please top up your Namecheap account.`;
            } else {
              balanceText += `✅ <b>Funds Available</b>`;
            }
          } else {
            balanceText = `💳 <b>Account Balance:</b> <i>Unavailable</i>`;
          }

          bot.sendMessage(
            chatId,
            `🎉 <b>Domain Available!</b>\n\n📌 Domain: <b>${result.domain}</b>\n💰 Price: <b>${result.price}</b>\n⚖️ Type: ${priceInfo}\n\n${balanceText}\n\nDo you want to proceed with registration?`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ Confirm Purchase",
                      callback_data: "confirm_purchase",
                    },
                  ],
                  [{ text: "❌ Cancel", callback_data: "main_menu" }],
                ],
              },
            },
          );
        } else if (result.success && !result.available) {
          bot.sendMessage(
            chatId,
            `❌ <b>Domain Unavailable</b>\n\nThe domain <b>${domainName}</b> is already taken.\n\nPlease try another name:`,
            { parse_mode: "HTML" },
          );
        } else {
          bot.sendMessage(
            chatId,
            `⚠️ <b>Check Failed</b>\n\nError: ${result.message}\n\nPlease try again:`,
            { parse_mode: "HTML" },
          );
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    } else {
      // Bulk Search Check
      const keyword = input;
      bot.sendMessage(
        chatId,
        `🔎 <b>Searching Bulk Domains for:</b> ${keyword}...\n<i>(Filtering domains below $10.00)</i>`,
        { parse_mode: "HTML" },
      );

      try {
        const [result, balanceRes] = await Promise.all([
          namecheap.checkBulkDomains(keyword),
          namecheap.getBalances(),
        ]);

        if (result.success && result.domains.length > 0) {
          let balanceText = "";
          if (balanceRes.success) {
            balanceText = `💳 <b>Balance:</b> $${balanceRes.availableBalance} ${balanceRes.currency}\n\n`;
          }

          // Arrange buttons in 2 columns for better display
          const buttons = [];
          for (let i = 0; i < result.domains.length; i += 2) {
            const row = [];
            row.push({
              text: `${result.domains[i].domain} (${result.domains[i].price})`,
              callback_data: `sel_dom:${result.domains[i].domain}:${result.domains[i].price}`,
            });

            if (result.domains[i + 1]) {
              row.push({
                text: `${result.domains[i + 1].domain} (${result.domains[i + 1].price})`,
                callback_data: `sel_dom:${result.domains[i + 1].domain}:${result.domains[i + 1].price}`,
              });
            }
            buttons.push(row);
          }

          buttons.push([{ text: "❌ Cancel", callback_data: "main_menu" }]);

          bot.sendMessage(
            chatId,
            `${balanceText}✨ <b>Found ${result.domains.length} Domains for "${keyword}":</b>\nSelect one to proceed with purchase:`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: buttons,
              },
            },
          );
        } else if (result.success) {
          bot.sendMessage(
            chatId,
            `❌ <b>No cheap domains found</b> for "${keyword}" under $10.00.\n\nPlease try a different keyword:`,
            { parse_mode: "HTML" },
          );
        } else {
          bot.sendMessage(
            chatId,
            `⚠️ <b>Search Failed</b>\n\nError: ${result.message}\n\nPlease try again:`,
            { parse_mode: "HTML" },
          );
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    }
    return;
  }

  // --- Dynadot Domain Check Flow ---
  if (state.step === "AWAITING_DD_DOMAIN_CHECK") {
    const domain = text.trim();
    bot.sendMessage(
      chatId,
      `🔍 <b>Checking availability for:</b> ${domain}...`,
      { parse_mode: "HTML" },
    );

    try {
      const results = await dynadot.searchDomain(domain);

      // Check if results is array
      if (Array.isArray(results)) {
        // If empty array, it means no domains passed the filter (or API failed silently)
        if (results.length === 0) {
          bot.sendMessage(
            chatId,
            `❌ <b>No Domains Found</b>\n\nNo available domains found matching "${domain}" under $10.00.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
                ],
              },
            },
          );
          delete userStates[chatId];
          return;
        }

        // Filter available domains
        const availableDomains = results.filter((r) => r.available);

        if (availableDomains.length > 0) {
          let msg = `🎉 <b>Found ${availableDomains.length} Available Domains!</b>\n\n`;
          const buttons = [];

          availableDomains.forEach((r) => {
            msg += `✅ <b>${r.domain}</b> - $${r.price}\n`;
            buttons.push([
              {
                text: `🛒 Buy ${r.domain} ($${r.price})`,
                callback_data: `dd_confirm_buy:${r.domain}`,
              },
            ]);
          });

          buttons.push([
            { text: "⬅️ Back to Menu", callback_data: "dynadot_menu" },
          ]);

          bot.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: buttons,
            },
          });
        } else {
          // Show unavailable message
          let msg = `❌ <b>No Cheap Domains Available</b>\n\nAll checked extensions for <b>${domain}</b> are either taken or cost more than $10.00.\n\n`;

          bot.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
              ],
            },
          });
        }
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Check Failed</b>\n\nNo results returned.`,
          { parse_mode: "HTML" },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ System Error: ${err.message}`);
    }
    delete userStates[chatId];
    return;
  }

  // --- Dynadot Buy Flow (Name Input) ---
  if (state.step === "AWAITING_DD_DOMAIN_BUY") {
    const domain = text.trim();
    bot.sendMessage(
      chatId,
      `🔍 <b>Checking availability for:</b> ${domain}...`,
      { parse_mode: "HTML" },
    );

    try {
      const results = await dynadot.searchDomain(domain);

      // Check if results is array
      if (Array.isArray(results)) {
        // If empty array, it means no domains passed the filter (or API failed silently)
        if (results.length === 0) {
          bot.sendMessage(
            chatId,
            `❌ <b>No Domains Found</b>\n\nNo available domains found matching "${domain}" under $10.00.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
                ],
              },
            },
          );
          delete userStates[chatId];
          return;
        }

        const availableDomains = results.filter((r) => r.available);

        if (availableDomains.length > 0) {
          const balance = await dynadot.getBalance();
          let msg = `🎉 <b>Found ${availableDomains.length} Available Domains!</b>\n💳 Balance: <b>$${balance}</b>\n\nSelect a domain to purchase using your account balance:`;
          const buttons = [];
          let row = [];

          availableDomains.forEach((r, index) => {
            // Create button: domain ($price)
            const label = `${r.domain} ($${r.price})`;
            row.push({
              text: label,
              callback_data: `dd_confirm_buy:${r.domain}`,
            });

            // 2 buttons per row
            if (row.length === 2) {
              buttons.push(row);
              row = [];
            }
          });

          // Add remaining buttons
          if (row.length > 0) {
            buttons.push(row);
          }

          buttons.push([{ text: "❌ Cancel", callback_data: "dynadot_menu" }]);

          bot.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: buttons,
            },
          });
        } else {
          let msg = `❌ <b>No Cheap Domains Available</b>\n\nAll checked extensions for <b>${domain}</b> are either taken or cost more than $10.00.\n\n`;

          bot.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
              ],
            },
          });
        }
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Check Failed</b>\n\nNo results returned.`,
          { parse_mode: "HTML" },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ System Error: ${err.message}`);
    }
    delete userStates[chatId];
    return;
  }

  // --- Dynadot DNS Update Flow ---
  if (state.step === "AWAITING_DD_DNS_DOMAIN") {
    userStates[chatId] = { step: "AWAITING_DD_DNS_NS", domain: text.trim() };
    bot.sendMessage(
      chatId,
      `📝 <b>Enter Nameservers</b>\n\nFor <b>${text.trim()}</b>, please enter the nameservers separated by commas:\n(e.g., <code>ns1.cloudflare.com, ns2.cloudflare.com</code>)`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (state.step === "AWAITING_DD_DNS_NS") {
    const domain = userStates[chatId].domain;
    const nsInput = text.trim();
    const nameservers = nsInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);

    if (nameservers.length < 2) {
      bot.sendMessage(chatId, `⚠️ Please provide at least 2 nameservers.`);
      return;
    }

    bot.sendMessage(chatId, `⏳ <b>Updating Nameservers...</b>`, {
      parse_mode: "HTML",
    });

    try {
      const result = await dynadot.setNameservers(domain, nameservers);
      if (result.success) {
        bot.sendMessage(
          chatId,
          `✅ <b>Success!</b> Nameservers updated for ${domain}.`,
        );
      } else {
        bot.sendMessage(chatId, `❌ <b>Failed:</b> ${result.message}`);
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    delete userStates[chatId];
    return;
  }

  // Step 1: Receive Name
  if (state.step === "AWAITING_NAME") {
    userStates[chatId] = { step: "AWAITING_URL", name: text };
    bot.sendMessage(
      chatId,
      `✅ Name set to: <b>${text}</b>\n\n🔗 Now, please enter the <b>API URL</b> (e.g., https://example.com/api):`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Step 2: Receive URL
  if (state.step === "AWAITING_URL") {
    const name = userStates[chatId].name;
    let url = text.trim();

    // Basic URL validation/fix
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    // Clean URL: Remove trailing slash
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }

    // Clean URL: Remove common UI paths if user pasted browser URL
    const commonPaths = ["/login", "/admin", "/dashboard", "/home"];
    for (const path of commonPaths) {
      if (url.endsWith(path)) {
        url = url.substring(0, url.length - path.length);
      }
    }

    // Clean URL: Remove trailing slash again after path removal
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }

    // Auto-append /api if missing
    if (!url.endsWith("/api")) {
      url = url + "/api";
    }

    const newDomain = {
      name: name,
      url: url,
      has_merchant: false, // Default as requested
    };

    try {
      saveDomain(chatId, newDomain);
      delete userStates[chatId]; // Clear state

      bot.sendMessage(
        chatId,
        `✅ <b>Domain Added Successfully!</b>\n\n📌 Name: ${name}\n🔗 URL: ${url}\n\nSelect an option below:`,
        {
          parse_mode: "HTML",
          reply_markup: getDomainKeyboard(chatId),
        },
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error saving domain: ${err.message}`);
    }
    return;
  }

  // --- Developer Withdraw Flow ---

  // Step 3: Receive Amount & Submit
  if (state.step === "WITHDRAW_AWAITING_AMOUNT") {
    if (state.processing) return; // Prevent double submission

    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(
        chatId,
        `❌ Invalid amount. Please enter a valid number:`,
      );
      return;
    }

    if (amount > state.available_balance) {
      bot.sendMessage(
        chatId,
        `❌ Insufficient balance. Available: ₱${state.available_balance.toLocaleString()}\nPlease enter a lower amount:`,
      );
      return;
    }

    state.processing = true; // Set flag
    state.amount = amount;

    bot.sendMessage(
      chatId,
      `⏳ <b>Submitting Withdrawal via Galaxy API...</b>\n\n💰 Amount: ₱${amount.toLocaleString()}\n👤 Name: ${state.account_name}\n💳 Number: ${state.account_number}\n📱 Type: Maya2\n\n<i>Calling Galaxy Payment gateway directly...</i>`,
      { parse_mode: "HTML" },
    );

    // Generate unique order ID: BOTDEV + timestamp + random
    const orderId = `BOTDEV${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    // Callback URL — Galaxy will POST here when payout completes
    const callbackUrl = "https://a-gl.lat/api/galaxy-withdrawal-callback";

    galaxyService
      .initiateWithdrawal({
        amount: state.amount,
        orderId: orderId,
        bank: "PMP",
        bankCardName: state.account_name,
        bankCardAccount: state.account_number,
        bankCardRemark: "Bot Dev Withdraw",
        callbackUrl: callbackUrl,
      })
      .then((result) => {
        if (result.success) {
          bot.sendMessage(
            chatId,
            `✅ <b>Withdrawal Submitted!</b>\n\n📌 Order: <code>${orderId}</code>\n💰 Amount: ₱${state.amount.toLocaleString()}\n🏦 Method: Maya2\n👤 To: ${state.account_name} (${state.account_number})\n\nStatus: <b>Processing</b>\n<i>Galaxy will process and callback when complete.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: getDomainKeyboard(chatId),
            },
          );
        } else {
          bot.sendMessage(
            chatId,
            `❌ <b>Withdrawal Failed</b>\n\nReason: ${result.message || result.error || "Unknown error"}`,
            {
              parse_mode: "HTML",
              reply_markup: getDomainKeyboard(chatId),
            },
          );
        }
        delete userStates[chatId];
      })
      .catch((err) => {
        const errorMsg = err.message || "Unknown error";
        bot.sendMessage(chatId, `❌ <b>Galaxy API Error</b>\n\n${errorMsg}`, {
          parse_mode: "HTML",
          reply_markup: getDomainKeyboard(chatId),
        });
        delete userStates[chatId];
      });
    return;
  }

  // --- One-Click Deploy Flow (MEGA ONLY) ---
  if (state.step === "AWAITING_DEPLOY_DOMAIN") {
    const domain = text.trim().toLowerCase();
    const zipFile = state.zipFile;
    const localPath = path.join(PRODUCTION_DIR, zipFile);
    const remotePath = `/tmp/${zipFile}`;

    console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] ══════════════════════════════════`);
    console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Deploy started - zipFile: ${zipFile}, domain: ${domain}`);
    console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] localPath (temp): ${localPath}`);
    console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] remotePath: ${remotePath}`);

    if (!domain.includes(".")) {
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] ABORT: Invalid domain format`);
      bot.sendMessage(
        chatId,
        "❌ Invalid domain. Please enter a full domain (e.g., example.com):",
      );
      return;
    }

    // Security check
    if (!isDomainOwner(chatId, domain)) {
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] ABORT: Domain ownership check failed for chatId=${chatId}, domain=${domain}`);
      bot.sendMessage(
        chatId,
        `❌ <b>Access Denied</b>\n\nThe domain <code>${domain}</code> is not in your domains list. Please use a domain you own.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    delete userStates[chatId]; // Clear state immediately

    // Initialize deployment state
    const deployState = { adminUrl: "" };

    const statusMsg = await bot.sendMessage(
      chatId,
      `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Initializing...</i>`,
      { parse_mode: "HTML" },
    );

    try {
      // 0. MEGA ONLY: Always download from MEGA Cloud
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Step 0: Downloading from MEGA Cloud...`);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] MEGA_FOLDER_URL configured: ${!!(process.env.MEGA_FOLDER_URL && !process.env.MEGA_FOLDER_URL.includes("YOUR_FOLDER_ID"))}`);
      
      if (
        !process.env.MEGA_FOLDER_URL ||
        process.env.MEGA_FOLDER_URL.includes("YOUR_FOLDER_ID")
      ) {
        console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] ABORT: MEGA is not configured`);
        throw new Error(
          `MEGA is not configured. Please set MEGA_FOLDER_URL in .env`,
        );
      }

      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Downloading from MEGA Cloud...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      // Delete existing local file if any (stale)
      if (fs.existsSync(localPath)) {
        console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Removing stale local file: ${localPath}`);
        fs.unlinkSync(localPath);
      }

      const megaStart = Date.now();
      await megaService.downloadTemplate(zipFile, localPath);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] MEGA download completed in ${Date.now() - megaStart}ms`);
      
      // Verify download
      if (!fs.existsSync(localPath)) {
        console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] ABORT: File not found after MEGA download at ${localPath}`);
        throw new Error(`MEGA download failed: file not found at ${localPath}`);
      }
      const dlStats = fs.statSync(localPath);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Downloaded file size: ${(dlStats.size / 1024 / 1024).toFixed(2)} MB`);

      // 1. Upload File to VPS via SFTP
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Step 1: Uploading to VPS via SFTP...`);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Source: ${localPath}`);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Destination: ${remotePath}`);
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Uploading ZIP to VPS (0%)...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const uploadStart = Date.now();
      await serverManager.uploadFile(localPath, remotePath, (percent) => {
        bot
          .editMessageText(
            `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Uploading ZIP to VPS (${percent}%)...</i>`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: "HTML",
            },
          )
          .catch(() => {});
      });
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] SFTP upload completed in ${Date.now() - uploadStart}ms`);

      // 2. Create Site in CloudPanel
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Creating site in CloudPanel...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const siteRes = await serverManager.createSite(domain);
      if (!siteRes.success)
        throw new Error(`CloudPanel Error: ${siteRes.message}`);

      if (siteRes.alreadyExists) {
        await bot.editMessageText(
          `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Site already exists, skipping creation...</i>`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "HTML",
          },
        );
        await new Promise((r) => setTimeout(r, 1500)); // Brief pause so user sees the skip
      }

      // 3. Unzip and Deploy
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Extracting files...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const deployRes = await serverManager.deployZip(domain, remotePath);
      if (!deployRes.success)
        throw new Error(`Deployment Error: ${deployRes.message}`);

      // 4. Create Database
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Creating database...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      // CloudPanel DB names/users must be alphanumeric and start with a letter
      const dbName =
        "db" +
        Math.random()
          .toString(36)
          .slice(-8)
          .replace(/[^a-z0-9]/g, "");
      const dbUser =
        "u" +
        Math.random()
          .toString(36)
          .slice(-8)
          .replace(/[^a-z0-9]/g, "");
      const dbPass =
        Math.random()
          .toString(36)
          .slice(-10)
          .replace(/[^a-z0-9]/g, "") + "A1!";

      const dbRes = await serverManager.createDatabase(
        domain,
        dbName,
        dbUser,
        dbPass,
      );
      if (!dbRes.success) throw new Error(`Database Error: ${dbRes.message}`);

      // 5. Update .env
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Configuring .env...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const envRes = await serverManager.updateEnvFile(
        domain,
        dbName,
        dbUser,
        dbPass,
      );
      if (!envRes.success)
        throw new Error(`.env Update Error: ${envRes.message}`);

      // 6. Auto-Import SQL if exists
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Checking for SQL data...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const findSql = await serverManager.execCommand(
        `find ${deployRes.sitePath} -name "*.sql" | head -n 1`,
      );
      const sqlPath = findSql.output.trim();

      if (sqlPath) {
        await bot.editMessageText(
          `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Importing database data...</i>`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "HTML",
          },
        );
        const importRes = await serverManager.importSql(
          dbName,
          dbUser,
          dbPass,
          sqlPath,
        );
        if (!importRes.success) {
          console.error(`SQL Import failed for ${domain}:`, importRes.message);
          deployState.adminUrl = "⚠️ SQL Import Failed";
        } else {
          // 7. Randomize Admin Prefix
          await bot.editMessageText(
            `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Randomizing admin URL...</i>`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: "HTML",
            },
          );

          const newAdminPrefix = "admin" + Math.random().toString(36).slice(-8);
          // Use a more robust update that doesn't strictly depend on ID=1
          const updateQuery = `UPDATE general SET admin_route_prefix = '${newAdminPrefix}' LIMIT 1;`;

          const adminRes = await serverManager.executeQuery(
            dbName,
            dbUser,
            dbPass,
            updateQuery,
          );
          if (adminRes.success) {
            deployState.adminUrl = `https://${domain}/${newAdminPrefix}/login`;
          } else {
            console.error(`Admin randomization failed:`, adminRes.message);
            deployState.adminUrl = "⚠️ DB Update Failed";
          }
        }
      } else {
        deployState.adminUrl = "⚠️ No SQL file found";
      }

      // 8. Add Cron Job (Run every 5 minutes) via cron-job.org
      await bot.editMessageText(
        `🚀 <b>Starting One-Click Deploy</b>\n━━━━━━━━━━━━━━━━━━\n📦 File: <code>${zipFile}</code>\n🌐 Domain: <b>${domain}</b>\n\n⏳ Status: <i>Setting up cron job (cron-job.org)...</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
        },
      );

      const cronUrl = `https://${domain}/getcronhaha`;
      const cronTitle = `Cron for ${domain}`;

      // First check if it exists
      const existingJobRes =
        await serverManager.cronJobOrg.findJobByUrl(cronUrl);
      if (existingJobRes.success && existingJobRes.job) {
        console.log(`Cron job already exists for ${domain} on cron-job.org`);
      } else {
        const cronRes = await serverManager.cronJobOrg.createJob(
          cronTitle,
          cronUrl,
        );
        if (!cronRes.success) {
          console.error(
            `Cron-job.org setup failed for ${domain}:`,
            cronRes.message,
          );
        }
      }

      // Also keep local crontab as backup
      const localCronCommand = `*/5 * * * * curl -s https://${domain}/getcronhaha`;
      await serverManager.addCronJob(
        domain,
        siteRes.siteUser,
        localCronCommand,
      );

      // Final Success
      const adminLink = deployState.adminUrl || "⚠️ Not Generated (Check SQL)";
      bot.editMessageText(
        `✅ <b>Deployment Successful!</b>\n━━━━━━━━━━━━━━━━━━\n🌐 Domain: <b>${domain}</b>\n📦 Template: <code>${zipFile}</code>\n🔐 Admin URL: <code>${adminLink}</code>\n\n📂 Site Path: <code>${deployRes.sitePath}</code>\n🗄️ DB Name: <code>${dbName}</code>\n👤 DB User: <code>${dbUser}</code>\n🔑 DB Pass: <code>${dbPass}</code>\n\n⏱️ Cron Job: <code>*/5 * * * *</code>\n🚀 <i>Your site is now live!</i>`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        },
      );

      // Also add to domains.json automatically (only if not already there)
      const currentDomains = loadDomains(chatId);
      const exists = currentDomains.some((d) => d.url.includes(domain));
      if (!exists) {
        saveDomain(chatId, {
          name: domain.split(".")[0],
          url: `https://${domain}/api`,
          has_merchant: false,
        });
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] ❌ DEPLOY FAILED: ${err.message}`);
      console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] Stack: ${err.stack}`);
      bot.editMessageText(
        `❌ <b>Deployment Failed</b>\n━━━━━━━━━━━━━━━━━━\n❌ Error: ${err.message}`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        },
      );
    } finally {
      // Cleanup: Always delete the temp MEGA file to save space
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Cleanup: Checking for temp file at ${localPath}`);
      if (fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
          console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] 🗑️ Cleaned up temporary MEGA file: ${zipFile}`);
        } catch (err) {
          console.error(
            `[${new Date().toISOString()}] [BOT_DEPLOY] ❌ Failed to delete temporary file ${zipFile}:`,
            err.message,
          );
        }
      }
    }
    return;
  }
});

// Callback Query Handler
bot.on("callback_query", async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;

  // --- Rate Limiting Check ---
  const rateCheck = isRateLimited(chatId);
  if (rateCheck.limited) {
    bot.answerCallbackQuery(callbackQuery.id, {
      text: rateCheck.message.replace(/<[^>]*>/g, ""),
      show_alert: true,
    });
    return;
  }

  if (!checkAccess(callbackQuery)) return;
  const data = callbackQuery.data;
  const domains = loadDomains(chatId);

  // Bundler Module
  if (data.startsWith("bundler_")) {
    bundlerService.handleCallback(bot, callbackQuery, userStates);
    return;
  }

  // 1. Main Menu / Refresh
  if (data === "main_menu" || data === "refresh_domains") {
    // Clear state on return to menu
    if (userStates[chatId]) delete userStates[chatId];

    const message = `
🤖 <b>System Monitor</b>
━━━━━━━━━━━━━━━━━━
Select an option below:
(Tip: Send /help for instructions)
`;
    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      reply_markup: getDomainKeyboard(chatId),
    });
    bot.answerCallbackQuery(callbackQuery.id, { text: "Menu refreshed" });
    return;
  }

  // 5. ADD DOMAIN
  if (data === "add_domain") {
    userStates[chatId] = { step: "AWAITING_NAME" };

    bot.sendMessage(
      chatId,
      `➕ <b>Add New Domain</b>\n\nPlease enter the <b>Display Name</b> for this domain:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "main_menu" }],
          ],
        },
      },
    );

    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.0.5 Manage Existing Sites
  if (data === "server_manage_sites") {
    bot.editMessageText(`⏳ <b>Fetching Sites from Server...</b>`, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
    });

    try {
      const result = await serverManager.listSites();
      if (result.success) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);

        // Extract clean base domains for comparison
        const userDomainNames = [
          ...new Set(
            userDomainsData
              .map((d) => {
                const name = getDomainFromUrl(d.name || "");
                const domain = getDomainFromUrl(d.domain || "");
                return [name, domain];
              })
              .flat()
              .filter((n) => n !== ""),
          ),
        ];

        // Filter server sites to only show those that belong to the user
        const filteredSites = result.sites.filter((site) =>
          userDomainNames.includes(site.toLowerCase()),
        );

        if (filteredSites.length === 0) {
          bot.editMessageText(
            `ℹ️ <b>No sites found</b> in your domain list that exist on this server.\n\nTotal server sites: ***\nYour tracked domains: ${userDomainsData.length}`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getServerKeyboard(),
            },
          );
        } else {
          const buttons = [];
          filteredSites.forEach((domain) => {
            buttons.push([
              {
                text: `🌐 ${domain}`,
                callback_data: `srv_manage_site:${domain}`,
              },
            ]);
          });

          buttons.push([
            { text: "⬅️ Back to Server Tools", callback_data: "server_menu" },
          ]);

          bot.editMessageText(
            `🌐 <b>Manage Existing Sites</b>\n━━━━━━━━━━━━━━━━━━\nFound <b>${filteredSites.length}</b> of your sites on CloudPanel.\n\nSelect a site to manage:`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buttons },
            },
          );
        }
      } else {
        bot.editMessageText(
          `❌ <b>Failed to list sites:</b>\n${result.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("srv_manage_site:")) {
    const domain = data.split(":")[1];

    // Security check
    if (!isDomainOwner(chatId, domain)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: This domain does not belong to you.",
        show_alert: true,
      });
      return;
    }

    bot.editMessageText(
      `🌐 <b>Managing:</b> <code>${domain}</code>\n━━━━━━━━━━━━━━━━━━\nSelect an action for this site:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Open Site", url: `https://${domain}` }],
            [
              {
                text: "🚀 Clone This Site",
                callback_data: `srv_clone_src:${domain}`,
              },
            ],
            [{ text: "⏰ View Cron Jobs", callback_data: `server_cron_list` }], // This lists all, but good enough
            [
              {
                text: "⬅️ Back to Sites List",
                callback_data: "server_manage_sites",
              },
            ],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.1.5 Manage Cron Jobs (cron-job.org)
  if (data === "server_cron_list") {
    bot.editMessageText(
      `⏳ <b>Fetching Cron Jobs...</b>\n<i>Connecting to cron-job.org...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const res = await serverManager.cronJobOrg.listJobs();
      if (res.success) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);
        const userDomainNames = userDomainsData
          .map((d) => (d.name || d.domain || "").toLowerCase())
          .filter((n) => n !== "");

        // Filter cron jobs: Show only if job.url or job.title contains one of user's domains
        const filteredJobs = res.jobs.filter((job) => {
          const url = (job.url || "").toLowerCase();
          const title = (job.title || "").toLowerCase();
          return userDomainNames.some(
            (domain) => url.includes(domain) || title.includes(domain),
          );
        });

        const buttons = [];
        filteredJobs.forEach((job) => {
          const statusIcon = job.enabled ? "✅" : "❌";
          buttons.push([
            {
              text: `${statusIcon} ${job.title}`,
              callback_data: `cron_view:${job.jobId}`,
            },
          ]);
        });

        buttons.push([
          { text: "➕ Add New Job", callback_data: "server_cron_add_prompt" },
        ]);
        buttons.push([
          { text: "⬅️ Back to Server Tools", callback_data: "server_menu" },
        ]);

        bot.editMessageText(
          `⏰ <b>Cron Jobs (cron-job.org)</b>\n━━━━━━━━━━━━━━━━━━\nFound <b>${filteredJobs.length}</b> of your jobs.\n\nSelect a job to manage:`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.editMessageText(`❌ <b>Failed to fetch jobs:</b>\n${res.message}`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cron_view:")) {
    const jobId = data.split(":")[1];
    try {
      const res = await serverManager.cronJobOrg.listJobs();
      if (res.success) {
        const job = res.jobs.find((j) => j.jobId == jobId);
        if (job) {
          // Get user's domains from their local domains.json
          const userDomainsData = loadDomains(chatId);
          const userDomainNames = userDomainsData
            .map((d) => (d.name || d.domain || "").toLowerCase())
            .filter((n) => n !== "");

          // Security check
          const url = (job.url || "").toLowerCase();
          const title = (job.title || "").toLowerCase();
          const isOwner = userDomainNames.some(
            (domain) => url.includes(domain) || title.includes(domain),
          );

          if (!isOwner) {
            bot.answerCallbackQuery(callbackQuery.id, {
              text: "❌ Access Denied: This job does not belong to your domains.",
              show_alert: true,
            });
            return;
          }

          const status = job.enabled ? "✅ Enabled" : "❌ Disabled";
          bot.editMessageText(
            `📝 <b>Cron Job Details</b>\n━━━━━━━━━━━━━━━━━━\n<b>Title:</b> <code>${job.title}</code>\n<b>URL:</b> <code>${job.url}</code>\n<b>Status:</b> ${status}\n<b>Last Execution:</b> ${job.lastExecution > 0 ? new Date(job.lastExecution * 1000).toLocaleString() : "Never"}\n\nWhat do you want to do?`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to List",
                      callback_data: "server_cron_list",
                    },
                  ],
                ],
              },
            },
          );
        }
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.1.6 Add New Cron Job Prompt
  if (data === "server_cron_add_prompt") {
    userStates[chatId] = { step: "AWAITING_CRON_TITLE" };
    bot.sendMessage(
      chatId,
      `➕ <b>Add New Cron Job</b>\n━━━━━━━━━━━━━━━━━━\nPlease enter a <b>Title</b> for this cron job:\n(e.g., Cron for example.com)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "server_cron_list" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6. Namecheap Menu Handler
  if (data === "namecheap_menu") {
    if (userStates[chatId]) delete userStates[chatId];

    bot.editMessageText(
      `🌐 <b>Namecheap Tools</b>\n━━━━━━━━━━━━━━━━━━\nManage your domains and purchases directly from here.`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getNamecheapKeyboard(),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.5 Cloudflare Menu Handler
  if (data === "cloudflare_menu") {
    if (userStates[chatId]) delete userStates[chatId];

    bot.editMessageText(
      `☁️ <b>Cloudflare Tools</b>\n━━━━━━━━━━━━━━━━━━\n<i>Fetching account nameservers...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const zones = await cloudflare.listZones(1);
      let nsText = "<i>No domains found to check nameservers.</i>";

      if (zones.success && zones.domains.length > 0) {
        // Find a domain that has nameservers assigned
        const domainWithNs = zones.domains.find(
          (d) => d.name_servers && d.name_servers.length > 0,
        );
        if (domainWithNs) {
          nsText = `Nameservers:\n<code>${domainWithNs.name_servers.join("\n")}</code>`;
        }
      }

      bot.editMessageText(
        `☁️ <b>Cloudflare Tools</b>\n━━━━━━━━━━━━━━━━━━\n${nsText}\n\nManage your Cloudflare domains and protection.`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    } catch (err) {
      bot.editMessageText(
        `☁️ <b>Cloudflare Tools</b>\n━━━━━━━━━━━━━━━━━━\nManage your Cloudflare domains and protection.`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.5.1 Cloudflare Management Menu
  if (data === "cf_management_menu") {
    bot.editMessageText(
      `⚙️ <b>Cloudflare Global Settings</b>\n━━━━━━━━━━━━━━━━━━\nConfigure automatic protection for new domains.`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getCloudflareManagementKeyboard(chatId),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.5.2 Toggle Auto-WAF
  if (data === "toggle_cf_auto_waf") {
    const settings = loadSettings(chatId);
    settings.auto_cf_waf = !settings.auto_cf_waf;
    saveSettings(chatId, settings);
    bot.editMessageReplyMarkup(getCloudflareManagementKeyboard(chatId), {
      chat_id: chatId,
      message_id: msg.message_id,
    });
    bot.answerCallbackQuery(callbackQuery.id, {
      text: `Auto-WAF is now ${settings.auto_cf_waf ? "ENABLED" : "DISABLED"}`,
    });
    return;
  }

  // 6.5.3 Toggle WAF Options
  if (data.startsWith("toggle_cf_waf_")) {
    const option = data.replace("toggle_cf_waf_", "");
    const settings = loadSettings(chatId);

    if (option === "asn")
      settings.cf_waf_options.enableAsnWhitelist =
        !settings.cf_waf_options.enableAsnWhitelist;
    if (option === "ph")
      settings.cf_waf_options.enablePhOnly =
        !settings.cf_waf_options.enablePhOnly;
    if (option === "vpn")
      settings.cf_waf_options.enableVpnBlocking =
        !settings.cf_waf_options.enableVpnBlocking;

    saveSettings(chatId, settings);
    bot.editMessageReplyMarkup(getCloudflareManagementKeyboard(chatId), {
      chat_id: chatId,
      message_id: msg.message_id,
    });
    bot.answerCallbackQuery(callbackQuery.id, { text: "Setting Updated" });
    return;
  }

  // 6.6 Cloudflare Add Domain Prompt
  if (data === "cf_add_domain_prompt") {
    userStates[chatId] = { step: "AWAITING_CF_DOMAIN" };
    bot.sendMessage(
      chatId,
      `☁️ <b>Add Domain to Cloudflare</b>\n\nPlease enter the <b>Domain Name</b> (e.g., example.com) to automatically add and point it to your server:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "cloudflare_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7 Cloudflare Protection Prompt
  if (data === "cf_protection_prompt") {
    userStates[chatId] = { step: "AWAITING_CF_PROTECTION_DOMAIN" };
    bot.sendMessage(
      chatId,
      `🛡️ <b>Enable Protection</b>\n\nPlease enter the <b>Domain Name</b> (e.g., example.com) to enable <b>Under Attack Mode</b>:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "cloudflare_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7.1 Change DNS IP Menu
  if (data === "cf_change_ip_menu") {
    bot.editMessageText(
      `🔄 <b>Change DNS IP Address</b>\n\nSelect an option:\n\n` +
      `🔴 <b>Maintenance Mode:</b> Point to 173.245.48.51 (Cloudflare parking/closed page)\n` +
      `🟢 <b>Restore to Server:</b> Point back to your server IP`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔴 Set Maintenance IP (173.245.48.51)",
                callback_data: "cf_set_maintenance_ip",
              },
            ],
            [
              {
                text: "🟢 Restore to Server IP",
                callback_data: "cf_restore_server_ip",
              },
            ],
            [
              {
                text: "🔧 Custom IP",
                callback_data: "cf_custom_ip_prompt",
              },
            ],
            [{ text: "⬅️ Back", callback_data: "cloudflare_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7.2 Set Maintenance IP
  if (data === "cf_set_maintenance_ip") {
    bot.editMessageText(
      `⏳ <b>Loading your domains...</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Get user's domains
      const userDomainsData = loadDomains(chatId);
      
      if (userDomainsData.length === 0) {
        bot.editMessageText(
          `❌ <b>No domains found</b>\n\nPlease add domains to your list first.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
              ],
            },
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Create buttons for each domain (2 per row)
      const buttons = [];
      for (let i = 0; i < userDomainsData.length; i += 2) {
        const row = [];
        const d1 = userDomainsData[i];
        const domain1 = getDomainFromUrl(d1.name || d1.url);
        row.push({
          text: `🔴 ${domain1}`,
          callback_data: `cf_ip_select:${domain1}:173.245.48.51:maintenance`,
        });
        
        if (userDomainsData[i + 1]) {
          const d2 = userDomainsData[i + 1];
          const domain2 = getDomainFromUrl(d2.name || d2.url);
          row.push({
            text: `🔴 ${domain2}`,
            callback_data: `cf_ip_select:${domain2}:173.245.48.51:maintenance`,
          });
        }
        buttons.push(row);
      }

      buttons.push([
        {
          text: "🔍 Search Domain",
          callback_data: "cf_ip_maintenance_search",
        },
      ]);
      buttons.push([
        { text: "⬅️ Back", callback_data: "cf_change_ip_menu" },
      ]);

      bot.editMessageText(
        `🔴 <b>Set Maintenance Mode</b>\n\n` +
        `Target IP: <code>173.245.48.51</code>\n\n` +
        `Select a domain to change:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        },
      );
    } catch (err) {
      bot.editMessageText(
        `❌ <b>Error:</b> ${err.message}`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
            ],
          },
        },
      );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7.3 Restore Server IP
  if (data === "cf_restore_server_ip") {
    const serverIp = process.env.TARGET_SERVER_IP || process.env.SSH_HOST;
    if (!serverIp) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Server IP not configured in environment variables",
        show_alert: true,
      });
      return;
    }
    
    bot.editMessageText(
      `⏳ <b>Loading your domains...</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Get user's domains
      const userDomainsData = loadDomains(chatId);
      
      if (userDomainsData.length === 0) {
        bot.editMessageText(
          `❌ <b>No domains found</b>\n\nPlease add domains to your list first.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
              ],
            },
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Create buttons for each domain (2 per row)
      const buttons = [];
      for (let i = 0; i < userDomainsData.length; i += 2) {
        const row = [];
        const d1 = userDomainsData[i];
        const domain1 = getDomainFromUrl(d1.name || d1.url);
        row.push({
          text: `🟢 ${domain1}`,
          callback_data: `cf_ip_select:${domain1}:${serverIp}:server`,
        });
        
        if (userDomainsData[i + 1]) {
          const d2 = userDomainsData[i + 1];
          const domain2 = getDomainFromUrl(d2.name || d2.url);
          row.push({
            text: `🟢 ${domain2}`,
            callback_data: `cf_ip_select:${domain2}:${serverIp}:server`,
          });
        }
        buttons.push(row);
      }

      buttons.push([
        {
          text: "🔍 Search Domain",
          callback_data: "cf_ip_server_search",
        },
      ]);
      buttons.push([
        { text: "⬅️ Back", callback_data: "cf_change_ip_menu" },
      ]);

      bot.editMessageText(
        `🟢 <b>Restore to Server</b>\n\n` +
        `Target IP: <code>${serverIp}</code>\n\n` +
        `Select a domain to change:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        },
      );
    } catch (err) {
      bot.editMessageText(
        `❌ <b>Error:</b> ${err.message}`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back", callback_data: "cf_change_ip_menu" }],
            ],
          },
        },
      );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7.4 Custom IP Prompt
  if (data === "cf_custom_ip_prompt") {
    userStates[chatId] = { 
      step: "AWAITING_CF_CUSTOM_IP",
      ipType: "custom"
    };
    bot.sendMessage(
      chatId,
      `🔧 <b>Custom IP Address</b>\n\n` +
      `Please enter the <b>IP Address</b> you want to point to (e.g., 1.2.3.4):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "cf_change_ip_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.7.5 Search domains for IP change
  if (data === "cf_ip_change_search" || data === "cf_ip_maintenance_search" || data === "cf_ip_server_search") {
    const ipType = data.includes("maintenance") ? "maintenance" : data.includes("server") ? "server" : "custom";
    const targetIp = ipType === "maintenance" ? "173.245.48.51" : ipType === "server" ? (process.env.TARGET_SERVER_IP || process.env.SSH_HOST) : "";
    
    userStates[chatId] = { 
      step: "AWAITING_CF_IP_CHANGE_SEARCH",
      targetIp: targetIp,
      ipType: ipType
    };
    bot.sendMessage(
      chatId,
      `🔍 <b>Search Domain</b>\n\nEnter part of the domain name to search:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "cf_change_ip_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.8 Cloudflare Search Prompt
  if (data === "cf_search_prompt") {
    userStates[chatId] = { step: "AWAITING_CF_SEARCH" };
    bot.sendMessage(
      chatId,
      `🔍 <b>Search Cloudflare Domain</b>\n\nPlease enter part of the <b>Domain Name</b> to search:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "cloudflare_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.9 Cloudflare List Zones (Domains)
  if (data.startsWith("cf_list_zones:")) {
    const page = parseInt(data.split(":")[1]) || 1;
    bot.editMessageText(
      `⏳ <b>Fetching Cloudflare Domains (Page ${page})...</b>\n<i>Please wait...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const result = await cloudflare.listZones(page);
      if (result.success && result.domains.length > 0) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);
        const userDomainNames = userDomainsData
          .map((d) => (d.name || d.domain || "").toLowerCase())
          .filter((n) => n !== "");

        // Filter Cloudflare domains to only show those that belong to the user
        const filteredDomains = result.domains.filter((d) =>
          userDomainNames.includes(d.name.toLowerCase()),
        );

        if (filteredDomains.length === 0) {
          bot.editMessageText(
            `ℹ️ <b>No domains found</b> in your list that exist on Cloudflare.\n\nTotal CF Domains: ***\nYour tracked domains: ${userDomainNames.length}`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to Cloudflare Tools",
                      callback_data: "cloudflare_menu",
                    },
                  ],
                ],
              },
            },
          );
          bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        const buttons = [];
        for (let i = 0; i < filteredDomains.length; i += 2) {
          const row = [];
          const d1 = filteredDomains[i];
          row.push({
            text: `${d1.status === "active" ? "✅" : "⏳"} ${d1.name}`,
            callback_data: `cf_manage:${d1.name}`,
          });
          if (filteredDomains[i + 1]) {
            const d2 = filteredDomains[i + 1];
            row.push({
              text: `${d2.status === "active" ? "✅" : "⏳"} ${d2.name}`,
              callback_data: `cf_manage:${d2.name}`,
            });
          }
          buttons.push(row);
        }

        // Pagination (Note: Filtered view might break pagination accuracy, but we keep the buttons)
        const navRow = [];
        if (page > 1) {
          navRow.push({
            text: "⬅️ Previous",
            callback_data: `cf_list_zones:${page - 1}`,
          });
        }
        if (result.pagination.total_pages > page) {
          navRow.push({
            text: "Next ➡️",
            callback_data: `cf_list_zones:${page + 1}`,
          });
        }
        if (navRow.length > 0) buttons.push(navRow);

        buttons.push([
          {
            text: "⬅️ Back to Cloudflare Tools",
            callback_data: "cloudflare_menu",
          },
        ]);

        bot.editMessageText(
          `📋 <b>Cloudflare Domains</b> (Page ${page})\n\nFound <b>${filteredDomains.length}</b> of your domains.\n\n✅ = Active\n⏳ = Pending/Other\n\nSelect a domain to manage:`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.editMessageText(`❌ <b>No domains found</b> in Cloudflare.`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ Error: ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getCloudflareKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.10 Cloudflare Manage Domain
  if (data.startsWith("cf_manage:")) {
    const domain = data.split(":")[1];
    bot.editMessageText(`⏳ <b>Loading domain info for ${domain}...</b>`, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
    });

    try {
      const zoneRes = await cloudflare.getZoneId(domain);
      if (zoneRes.success) {
        const dnsRes = await cloudflare.getDnsRecords(zoneRes.zoneId);
        const wafRes = await cloudflare.getWafStatus(zoneRes.zoneId);

        let dnsInfo = "No A-Records found.";
        if (dnsRes.success && dnsRes.records.length > 0) {
          dnsInfo = dnsRes.records
            .map(
              (r) =>
                `📍 <b>${r.name}</b> points to <code>${r.content}</code> ${r.proxied ? "(☁️ Proxied)" : ""}`,
            )
            .join("\n");
        }

        const isAsnEnabled = wafRes.success && wafRes.status.asnWhitelist;
        const isPhEnabled = wafRes.success && wafRes.status.phOnly;
        const isVpnEnabled = wafRes.success && wafRes.status.vpnBlocking;
        const isCountryEnabled =
          wafRes.success && wafRes.status.countryWhitelist;

        const asnIcon = isAsnEnabled ? "✅" : "🔴";
        const phIcon = isPhEnabled ? "✅" : "🔴";
        const vpnIcon = isVpnEnabled ? "✅" : "🔴";
        const countryIcon = isCountryEnabled ? "✅" : "🔴";

        const asnAction = isAsnEnabled ? "disable" : "enable";
        const phAction = isPhEnabled ? "disable" : "enable";
        const vpnAction = isVpnEnabled ? "disable" : "enable";
        const countryAction = isCountryEnabled ? "disable" : "enable";

        // Save ZoneID to domains.json if not already there
        updateDomainZoneId(chatId, domain, zoneRes.zoneId);

        bot.editMessageText(
          `☁️ <b>Managing: ${domain}</b>\n━━━━━━━━━━━━━━━━━━\n\n${dnsInfo}\n\nChoose an action for this domain:`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📍 Change DNS IP",
                    callback_data: `cf_change_ip_prompt:${domain}`,
                  },
                ],
                [
                  {
                    text: `${phIcon} PH Only Check`,
                    callback_data: `cf_toggle_waf:${domain}:ph_only:${phAction}`,
                  },
                ],
                [
                  {
                    text: `${vpnIcon} VPN/Proxy Check`,
                    callback_data: `cf_toggle_waf:${domain}:vpn:${vpnAction}`,
                  },
                ],
                [
                  {
                    text: `${asnIcon} PH ASN Check`,
                    callback_data: `cf_toggle_waf:${domain}:asn:${asnAction}`,
                  },
                ],
                [
                  {
                    text: `${countryIcon} Country Whitelist`,
                    callback_data: `cf_toggle_waf:${domain}:country:${countryAction}`,
                  },
                ],
                [
                  {
                    text: "🌍 Manage Whitelisted Countries",
                    callback_data: `cf_country_picker:${domain}`,
                  },
                ],
                [{ text: "⬅️ Back to List", callback_data: "cf_list_zones:1" }],
                [
                  {
                    text: "🏠 Cloudflare Menu",
                    callback_data: "cloudflare_menu",
                  },
                ],
              ],
            },
          },
        );
      } else {
        bot.editMessageText(`❌ <b>Error:</b> ${zoneRes.message}`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>System Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getCloudflareKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.10.2 Country Whitelist Management Menu
  if (data === "cf_country_whitelist_menu") {
    const domains = loadDomains(chatId);
    if (domains.length === 0) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ No domains found.",
        show_alert: true,
      });
      return;
    }

    const buttons = domains.map((d) => {
      const domainName = getDomainFromUrl(d.name || d.domain);
      return [
        {
          text: `🌍 ${domainName}`,
          callback_data: `cf_country_manage:${domainName}`,
        },
      ];
    });
    buttons.push([
      { text: "⬅️ Back to Cloudflare", callback_data: "cloudflare_menu" },
    ]);

    bot.editMessageText(
      `🌍 <b>Country Whitelist Management</b>\n\nSelect a domain to manage its whitelisted countries:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_manage:")) {
    const domain = data.split(":")[1];
    const domains = loadDomains(chatId);
    const domainData = domains.find(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );

    if (!domainData) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Domain not found.",
        show_alert: true,
      });
      return;
    }

    const whitelisted = domainData.whitelisted_countries || [
      "PH",
      "SG",
      "HK",
      "JP",
      "KW",
      "SA",
      "AE",
      "QA",
      "OM",
      "BH",
    ];
    const countryListText = whitelisted
      .map((c) => `<code>${c}</code>`)
      .join(", ");

    const buttons = [
      [
        {
          text: "➕ Add Country",
          callback_data: `cf_country_add_prompt:${domain}`,
        },
      ],
      [
        {
          text: "➖ Remove Country",
          callback_data: `cf_country_remove_menu:${domain}`,
        },
      ],
      [{ text: "⬅️ Back to List", callback_data: "cf_country_whitelist_menu" }],
    ];

    bot.editMessageText(
      `🌍 <b>Whitelist for: ${domain}</b>\n━━━━━━━━━━━━━━━━━━\n\n<b>Current Countries:</b>\n${countryListText}\n\n<i>Note: These countries will be allowed through Layer 4 protection.</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_add_prompt:")) {
    const domain = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_COUNTRY_CODE", domainName: domain };
    bot.sendMessage(
      chatId,
      `➕ <b>Add Country to Whitelist</b>\n\nPlease enter the 2-letter <b>Country Code</b> (e.g., US, GB, KR):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data: `cf_country_manage:${domain}`,
              },
            ],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_remove_menu:")) {
    const domain = data.split(":")[1];
    const domains = loadDomains(chatId);
    const domainData = domains.find(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );

    if (!domainData || !domainData.whitelisted_countries) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ No countries to remove.",
        show_alert: true,
      });
      return;
    }

    const buttons = [];
    const countries = domainData.whitelisted_countries;
    for (let i = 0; i < countries.length; i += 3) {
      const row = [];
      row.push({
        text: `❌ ${countries[i]}`,
        callback_data: `cf_country_remove_exec:${domain}:${countries[i]}`,
      });
      if (countries[i + 1])
        row.push({
          text: `❌ ${countries[i + 1]}`,
          callback_data: `cf_country_remove_exec:${domain}:${countries[i + 1]}`,
        });
      if (countries[i + 2])
        row.push({
          text: `❌ ${countries[i + 2]}`,
          callback_data: `cf_country_remove_exec:${domain}:${countries[i + 2]}`,
        });
      buttons.push(row);
    }
    buttons.push([
      { text: "⬅️ Back", callback_data: `cf_country_manage:${domain}` },
    ]);

    bot.editMessageText(
      `➖ <b>Remove Country</b>\n\nSelect a country to remove from the whitelist:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_remove_exec:")) {
    const [_, domain, country] = data.split(":");
    let domains = loadDomains(chatId);
    const domainIndex = domains.findIndex(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );

    if (domainIndex !== -1) {
      if (!domains[domainIndex].whitelisted_countries) {
        domains[domainIndex].whitelisted_countries = [
          "PH",
          "SG",
          "HK",
          "JP",
          "KW",
          "SA",
          "AE",
          "QA",
          "OM",
          "BH",
        ];
      }
      domains[domainIndex].whitelisted_countries = domains[
        domainIndex
      ].whitelisted_countries.filter((c) => c !== country);
      saveDomains(chatId, domains);
      bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Removed ${country}`,
        show_alert: false,
      });
      // Refresh menu
      const domainData = domains[domainIndex];
      const whitelisted = domainData.whitelisted_countries;
      const countryListText = whitelisted
        .map((c) => `<code>${c}</code>`)
        .join(", ");
      const buttons = [
        [
          {
            text: "➕ Add Country",
            callback_data: `cf_country_add_prompt:${domain}`,
          },
        ],
        [
          {
            text: "➖ Remove Country",
            callback_data: `cf_country_remove_menu:${domain}`,
          },
        ],
        [
          {
            text: "⬅️ Back to List",
            callback_data: "cf_country_whitelist_menu",
          },
        ],
      ];
      bot.editMessageText(
        `🌍 <b>Whitelist for: ${domain}</b>\n━━━━━━━━━━━━━━━━━━\n\n<b>Current Countries:</b>\n${countryListText}\n\n<i>Note: These countries will be allowed through Layer 4 protection.</i>`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        },
      );
    }
    return;
  }

  if (data.startsWith("cf_country_picker:")) {
    const parts = data.split(":");
    const domain = parts[1];
    const page = parseInt(parts[2] || "0");
    const searchQuery = parts[3] === "none" || !parts[3] ? "" : parts[3];
    const domains = loadDomains(chatId);
    const domainData = domains.find(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );
    const whitelisted =
      domainData && domainData.whitelisted_countries
        ? domainData.whitelisted_countries
        : ["PH", "SG", "HK", "JP", "KW", "SA", "AE", "QA", "OM", "BH"];

    const picker = getCountryPickerKeyboard(
      domain,
      whitelisted,
      page,
      searchQuery,
    );
    bot.editMessageText(
      `🌍 <b>Select Countries to Whitelist</b>\nDomain: <b>${domain}</b>\n\n${picker.header}\n\nClick a country to toggle. Selection will update Cloudflare instantly.`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: picker,
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_search_prompt:")) {
    const domain = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_COUNTRY_SEARCH", domain: domain };
    bot.sendMessage(
      chatId,
      `🔍 <b>Search Country for ${domain}</b>\n\nPlease enter the <b>Country Name</b> or <b>2-letter Code</b> to search:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data: `cf_country_picker:${domain}:0:none`,
              },
            ],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Handle IP Change - Domain Selected from List
  if (data.startsWith("cf_ip_select:")) {
    const parts = data.split(":");
    const domain = parts[1];
    const targetIp = parts[2];
    const ipType = parts[3];
    
    bot.editMessageText(
      `⏳ <b>Fetching current DNS records for ${domain}...</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Get Zone ID first
      const zoneRes = await cloudflare.getZoneId(domain);
      if (!zoneRes.success) {
        bot.editMessageText(
          `❌ <b>Domain Not Found</b>\n\nCould not find zone for ${domain}. Is it added to Cloudflare?`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Store zone ID in user state to avoid callback_data length limit
      userStates[chatId] = {
        step: "CF_IP_CONFIRM_PENDING",
        domain: domain,
        targetIp: targetIp,
        ipType: ipType,
        zoneId: zoneRes.zoneId,
      };

      // Get current DNS records
      const currentRecords = await cloudflare.getDnsRecords(zoneRes.zoneId);
      let currentDnsInfo = "";
      
      if (currentRecords.success && currentRecords.records.length > 0) {
        currentDnsInfo = "\n\n<b>📋 Current DNS Records:</b>\n";
        currentRecords.records.forEach(record => {
          const proxyStatus = record.proxied ? "🟠 Proxied" : "⚪ DNS Only";
          currentDnsInfo += `• ${record.name}\n  → <code>${record.content}</code> ${proxyStatus}\n`;
        });
      } else {
        currentDnsInfo = "\n\n<i>No existing A records found.</i>";
      }

      const ipTypeLabel = ipType === "maintenance" ? "🔴 Maintenance Mode" : ipType === "server" ? "🟢 Server Mode" : "🔧 Custom IP";

      // Show current records and ask for confirmation
      bot.editMessageText(
        `🔄 <b>DNS Change Confirmation</b>\n\n` +
        `📌 Domain: <b>${domain}</b>${currentDnsInfo}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `<b>🎯 New Configuration:</b>\n` +
        `${ipTypeLabel}\n` +
        `New IP: <code>${targetIp}</code>\n` +
        `Proxy: 🟠 Enabled\n\n` +
        `<i>Proceed with DNS update?</i>`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Update",
                  callback_data: `cf_ip_confirm_exec`,
                },
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data: "cf_change_ip_menu",
                },
              ],
            ],
          },
        },
      );
    } catch (err) {
      bot.editMessageText(
        `❌ <b>System Error</b>\n\n${err.message}`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Handle IP Change Execution from Search Results
  if (data.startsWith("cf_ip_change_exec:")) {
    const parts = data.split(":");
    const domain = parts[1];
    const targetIp = parts[2];
    const ipType = parts[3];
    
    bot.editMessageText(
      `⏳ <b>Fetching current DNS records for ${domain}...</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Get Zone ID first
      const zoneRes = await cloudflare.getZoneId(domain);
      if (!zoneRes.success) {
        bot.editMessageText(
          `❌ <b>Domain Not Found</b>\n\nCould not find zone for ${domain}. Is it added to Cloudflare?`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Get current DNS records
      const currentRecords = await cloudflare.getDnsRecords(zoneRes.zoneId);
      let currentDnsInfo = "";
      
      if (currentRecords.success && currentRecords.records.length > 0) {
        currentDnsInfo = "\n\n<b>📋 Current DNS Records:</b>\n";
        currentRecords.records.forEach(record => {
          const proxyStatus = record.proxied ? "🟠 Proxied" : "⚪ DNS Only";
          currentDnsInfo += `• ${record.name}\n  → <code>${record.content}</code> ${proxyStatus}\n`;
        });
      } else {
        currentDnsInfo = "\n\n<i>No existing A records found.</i>";
      }

      const ipTypeLabel = ipType === "maintenance" ? "🔴 Maintenance Mode" : ipType === "server" ? "🟢 Server Mode" : "🔧 Custom IP";

      // Show current records and ask for confirmation
      bot.editMessageText(
        `🔄 <b>DNS Change Confirmation</b>\n\n` +
        `📌 Domain: <b>${domain}</b>${currentDnsInfo}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `<b>🎯 New Configuration:</b>\n` +
        `${ipTypeLabel}\n` +
        `New IP: <code>${targetIp}</code>\n` +
        `Proxy: 🟠 Enabled\n\n` +
        `<i>Proceed with DNS update?</i>`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Update",
                  callback_data: `cf_ip_confirm:${domain}:${targetIp}:${ipType}:${zoneRes.zoneId}`,
                },
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data: "cf_change_ip_menu",
                },
              ],
            ],
          },
        },
      );
    } catch (err) {
      bot.editMessageText(
        `❌ <b>System Error</b>\n\n${err.message}`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Handle IP Change Confirmation
  if (data === "cf_ip_confirm_exec") {
    const state = userStates[chatId];
    
    if (!state || state.step !== "CF_IP_CONFIRM_PENDING") {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Session expired. Please start over.",
        show_alert: true,
      });
      return;
    }
    
    const domain = state.domain;
    const targetIp = state.targetIp;
    const ipType = state.ipType;
    const zoneId = state.zoneId;
    
    const ipTypeLabel = ipType === "maintenance" ? "🔴 Maintenance Mode" : ipType === "server" ? "🟢 Server Mode" : "🔧 Custom IP";
    
    bot.editMessageText(
      `⏳ <b>Updating DNS for ${domain}...</b>\n\n${ipTypeLabel}\nTarget IP: <code>${targetIp}</code>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Update DNS A record
      const result = await cloudflare.setDnsRecord(zoneId, domain, targetIp);
      
      if (result.success) {
        // Fetch updated DNS records to confirm
        bot.editMessageText(
          `⏳ <b>Verifying DNS update...</b>\n\n<i>Fetching updated records...</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
          },
        );

        // Wait a moment for Cloudflare to process
        await new Promise(resolve => setTimeout(resolve, 1500));

        const updatedRecords = await cloudflare.getDnsRecords(zoneId);
        let updatedDnsInfo = "";
        
        if (updatedRecords.success && updatedRecords.records.length > 0) {
          updatedDnsInfo = "\n\n<b>📋 Updated DNS Records:</b>\n";
          updatedRecords.records.forEach(record => {
            const proxyStatus = record.proxied ? "🟠 Proxied" : "⚪ DNS Only";
            const isNew = record.content === targetIp ? "✨ " : "";
            updatedDnsInfo += `${isNew}• ${record.name}\n  → <code>${record.content}</code> ${proxyStatus}\n`;
          });
        }

        bot.editMessageText(
          `✅ <b>DNS Updated Successfully!</b>\n\n` +
          `📌 Domain: <b>${domain}</b>\n` +
          `🌍 New IP: <code>${targetIp}</code>\n` +
          `${ipType === "maintenance" ? "🔴 Status: <b>Maintenance Mode</b>" : ipType === "server" ? "🟢 Status: <b>Live Server</b>" : "🔧 Status: <b>Custom IP</b>"}${updatedDnsInfo}\n\n` +
          `<i>✨ = Updated record\nDNS changes may take a few minutes to propagate globally.</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      } else {
        bot.editMessageText(
          `❌ <b>Failed to Update DNS</b>\n\nReason: ${result.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getCloudflareKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(
        `❌ <b>System Error</b>\n\n${err.message}`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getCloudflareKeyboard(),
        },
      );
    }
    
    delete userStates[chatId];
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("cf_country_toggle_exec:")) {
    const [_, domain, code, pageStr, searchQueryRaw] = data.split(":");
    const page = parseInt(pageStr || "0");
    const searchQuery =
      searchQueryRaw === "none" || !searchQueryRaw ? "" : searchQueryRaw;
    let domains = loadDomains(chatId);
    const domainIndex = domains.findIndex(
      (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
    );

    if (domainIndex !== -1) {
      if (!domains[domainIndex].whitelisted_countries) {
        domains[domainIndex].whitelisted_countries = [
          "PH",
          "SG",
          "HK",
          "JP",
          "KW",
          "SA",
          "AE",
          "QA",
          "OM",
          "BH",
        ];
      }

      const index = domains[domainIndex].whitelisted_countries.indexOf(code);
      if (index > -1) {
        domains[domainIndex].whitelisted_countries.splice(index, 1);
      } else {
        domains[domainIndex].whitelisted_countries.push(code);
      }
      saveDomains(chatId, domains);

      // Sync with Cloudflare instantly
      const whitelisted = domains[domainIndex].whitelisted_countries;

      // Prevent 400 error: Cloudflare requires at least one country in the set if using 'in'
      // If empty, we use a placeholder "XX" (invalid code) to avoid syntax error
      const effectiveWhitelisted =
        whitelisted.length > 0 ? whitelisted : ["XX"];
      const countryList = `{"${effectiveWhitelisted.join('" "')}"}`;

      const whitelistIps =
        "{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}";
      const bypassExpression = `(ip.src in ${whitelistIps})`;
      const expression = `(not ${bypassExpression} and not ip.geoip.country in ${countryList})`;

      try {
        const zoneRes = await cloudflare.getZoneId(domain);
        if (zoneRes.success) {
          const wafRes = await cloudflare.getWafStatus(zoneRes.zoneId);
          const isEnabled = wafRes.success && wafRes.status.countryWhitelist;

          // If whitelisted is empty and rule is enabled, maybe we should disable it?
          // But user might want to block everything. Using "XX" is safer.
          await cloudflare.syncRule(
            zoneRes.zoneId,
            "COUNTRY_WHITELIST",
            expression,
            "block",
            isEnabled,
          );
        }
      } catch (e) {
        console.error("Auto-sync failed:", e);
      }

      // Refresh the keyboard and message text
      const picker = getCountryPickerKeyboard(
        domain,
        whitelisted,
        page,
        searchQuery,
      );
      bot.editMessageText(
        `🌍 <b>Select Countries to Whitelist</b>\nDomain: <b>${domain}</b>\n\n${picker.header}\n\nClick a country to toggle. Selection will update Cloudflare instantly.`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: picker,
        },
      );
      bot.answerCallbackQuery(callbackQuery.id, {
        text: `${whitelisted.includes(code) ? "✅ Added" : "❌ Removed"} ${code}`,
      });
    }
    return;
  }

  // 6.10.1 Cloudflare Change IP Prompt
  if (data.startsWith("cf_change_ip_prompt:")) {
    const domain = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_CF_IP_CHANGE", domainName: domain };
    bot.sendMessage(
      chatId,
      `📍 <b>Change DNS IP for ${domain}</b>\n\nPlease enter the <b>New IP Address</b>:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: `cf_manage:${domain}` }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 6.11 Cloudflare Quick Actions
  if (data.startsWith("cf_toggle_waf:")) {
    const [_, domain, type, action] = data.split(":");
    const enabled = action === "enable";

    let ruleName = "";
    let expression = "";
    let displayName = "";

    if (type === "asn") {
      ruleName = "LEGIT_PH_ASN_ONLY";
      const whitelistIps =
        "{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}";
      const bypassExpression = `(ip.src in ${whitelistIps})`;
      // Comprehensive PH ASN List (Luzon, Visayas, Mindanao)
      // Includes all major telcos, regional fiber, cable TV, and infrastructure providers
      expression = `(not ${bypassExpression} and not ip.geoip.asnum in {10139 131173 131175 13123 131932 132044 132064 132148 132199 132203 132233 132796 133064 133202 133203 133204 133205 133464 134687 134707 134996 135421 135423 135607 136557 137404 138354 138965 139831 140608 141253 141381 147040 17534 17639 17651 17721 17855 17887 17970 18101 18151 18190 18206 18260 23930 23944 24492 24513 32212 3550 38227 38734 45117 45383 45456 45479 45542 45632 45638 45667 45754 45949 4608 4759 4768 4775 4777 4786 4795 4801 4811 55547 55670 55821 56099 56207 6648 7629 7635 9299 9317 9467 9548 9658 9813 9825 9922 9924 9927})`;
      displayName = "PH ASN Check";
    } else if (type === "ph_only") {
      ruleName = "PH_ONLY_PROTECTION";
      const whitelistIps =
        "{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}";
      const bypassExpression = `(ip.src in ${whitelistIps})`;
      expression = `(not ${bypassExpression} and ip.geoip.country ne "PH")`;
      displayName = "PH Only Check";
    } else if (type === "vpn") {
      ruleName = "VPN_PROXY_PROTECTION";
      const whitelistIps =
        "{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}";
      const bypassExpression = `(ip.src in ${whitelistIps})`;
      // Enhanced VPN detection using threat score and aggressive Data Center ASN blocking
      const badAsns =
        "{9009 13678 60068 16276 14061 202425 212238 32097 206264 49392 50673 211252 205016 39351 209533 210558 13375 20473 14576 14618 16509 20473 45102 16276 62567 12876 24940 36352 15169 8075 20940 54113 25017 396982 204428}";
      expression = `(not ${bypassExpression} and (cf.threat_score ge 10 or ip.geoip.asnum in ${badAsns}))`;
      displayName = "VPN/Proxy Check";
    } else if (type === "country") {
      ruleName = "COUNTRY_WHITELIST";
      const whitelistIps =
        "{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}";
      const bypassExpression = `(ip.src in ${whitelistIps})`;

      // Load whitelisted countries for this specific domain from domains.json
      const domains = loadDomains(chatId);
      const domainData = domains.find(
        (d) => getDomainFromUrl(d.name || d.domain) === domain.toLowerCase(),
      );
      const whitelistedCountries =
        domainData && domainData.whitelisted_countries
          ? domainData.whitelisted_countries
          : ["PH", "SG", "HK", "JP", "KW", "SA", "AE", "QA", "OM", "BH"];
      const effectiveWhitelisted =
        whitelistedCountries.length > 0 ? whitelistedCountries : ["XX"];
      const countryList = `{"${effectiveWhitelisted.join('" "')}"}`;

      expression = `(not ${bypassExpression} and not ip.geoip.country in ${countryList})`;
      displayName = "Country Whitelist";
    }

    bot.editMessageText(
      `⏳ <b>${enabled ? "Enabling" : "Disabling"} ${displayName} for ${domain}...</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const zoneRes = await cloudflare.getZoneId(domain);
      if (zoneRes.success) {
        const result = await cloudflare.syncRule(
          zoneRes.zoneId,
          ruleName,
          expression,
          "block",
          enabled,
        );

        if (result.success) {
          const statusText = enabled ? "Enabled" : "Disabled";
          bot.editMessageText(
            `✅ <b>${displayName}</b> has been <b>${statusText}</b> for <b>${domain}</b>`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back to Manage",
                      callback_data: `cf_manage:${domain}`,
                    },
                  ],
                ],
              },
            },
          );
        } else {
          bot.editMessageText(`❌ <b>Failed</b>\n\nReason: ${result.message}`, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⬅️ Back to Manage",
                    callback_data: `cf_manage:${domain}`,
                  },
                ],
              ],
            },
          });
        }
      }
    } catch (err) {
      bot.editMessageText(`❌ Error: ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8. Server Menu Handler
  if (data === "server_menu") {
    if (userStates[chatId]) delete userStates[chatId];

    bot.editMessageText(
      `🖥️ <b>Server Tools</b>\n━━━━━━━━━━━━━━━━━━\nManage your VPS and Sites directly.\n\nIP: <code>***.***.***.***</code>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.0 Deploy from MEGA Cloud
  if (data === "server_deploy_local") {
    try {
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Template listing requested by chatId=${chatId}`);
      
      // MEGA ONLY
      if (
        !process.env.MEGA_FOLDER_URL ||
        process.env.MEGA_FOLDER_URL.includes("YOUR_FOLDER_ID")
      ) {
        console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] MEGA_FOLDER_URL not configured`);
        bot.sendMessage(
          chatId,
          `❌ <b>MEGA not configured</b>\n\nPlease set <code>MEGA_FOLDER_URL</code> in your .env file.`,
          { parse_mode: "HTML" },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      bot.editMessageText(`⏳ <b>Connecting to MEGA Cloud...</b>`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      });

      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Fetching MEGA templates...`);
      const megaFiles = await megaService.listTemplates();
      const files = megaFiles.map((f) => f.name);
      console.log(`[${new Date().toISOString()}] [BOT_DEPLOY] Found ${files.length} templates: ${files.join(', ')}`);

      if (files.length === 0) {
        bot.sendMessage(
          chatId,
          `❌ <b>No ZIP files found</b> in <code>MEGA Cloud</code>\n\nPlease add your project .zip files to your MEGA folder first.`,
          { parse_mode: "HTML" },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      const buttons = files.map((f) => [
        { text: `📦 ${f}`, callback_data: `sel_zip:${f}` },
      ]);
      buttons.push([
        { text: "⬅️ Back to Server Menu", callback_data: "server_menu" },
      ]);

      bot.editMessageText(
        `📦 <b>Select a ZIP to Deploy</b>\n━━━━━━━━━━━━━━━━━━\nFound <b>${files.length}</b> templates in your MEGA Cloud.\n\nWhich one do you want to use?`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        },
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [BOT_DEPLOY] Template listing ERROR: ${err.message}`);
      bot.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`);
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data.startsWith("sel_zip:")) {
    const zipFile = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_DEPLOY_DOMAIN", zipFile: zipFile };

    bot.editMessageText(
      `🚀 <b>Deploying:</b> <code>${zipFile}</code>\n━━━━━━━━━━━━━━━━━━\nNow, please enter the <b>Domain Name</b> for this new site (e.g., example.com):`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "server_deploy_local" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.1 Check SSH
  if (data === "server_check_ssh") {
    bot.editMessageText(
      `⏳ <b>Testing Connection...</b>\n<i>Connecting to server...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const isConnected = await serverManager.checkConnection();
      if (isConnected) {
        const ipSuffix = (process.env.SSH_HOST || "")
          .split(".")
          .slice(-2)
          .join(".");
        bot.editMessageText(
          `✅ <b>Connection Successful!</b>\n\nServer is reachable and credentials are correct.\nConnected to: <b>...${ipSuffix}</b>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      } else {
        bot.editMessageText(
          `❌ <b>Connection Failed!</b>\n\nPlease check your .env credentials.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.1.1 VPS Health Check
  if (data === "server_vps_health") {
    bot.editMessageText(
      `🖥️ <b>VPS Health Check</b>\n━━━━━━━━━━━━━━━━━━\n\n⏳ Checking VPS status via Cloudzy API...\n<i>This may take a moment...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Use the SSH host to identify the VPS
      const vpsHost = process.env.SSH_HOST || process.env.VPS_HOSTNAME;

      if (!vpsHost) {
        bot.editMessageText(
          `❌ <b>VPS Health Check Failed</b>\n\nNo VPS hostname or IP configured.\nPlease set SSH_HOST or VPS_HOSTNAME in your .env file.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      const result = await serverManager.checkAndRestartVPS(vpsHost);

      if (result.success) {
        if (result.wasRestarted) {
          // VPS was restarted
          bot.editMessageText(
            `🔄 <b>VPS Auto-Restarted!</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
              `🖥️ <b>Hostname:</b> <code>${result.instance.hostname}</code>\n` +
              `📍 <b>IP:</b> <code>${result.instance.ip}</code>\n` +
              `⚠️ <b>Previous Status:</b> <code>${result.instance.previousStatus}</code>\n` +
              `🌐 <b>Network:</b> <code>${result.instance.previousNetworkStatus}</code>\n\n` +
              `✅ <b>Restart Initiated Successfully!</b>\n` +
              `⏰ <b>Time:</b> ${new Date().toLocaleString()}\n\n` +
              `<i>The VPS should be online shortly. Please wait 1-2 minutes before trying to connect.</i>`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getServerKeyboard(),
            },
          );
        } else {
          // VPS is healthy
          bot.editMessageText(
            `✅ <b>VPS is Healthy!</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
              `🖥️ <b>Hostname:</b> <code>${result.instance.hostname}</code>\n` +
              `📍 <b>IP:</b> <code>${result.instance.ip}</code>\n` +
              `✅ <b>Status:</b> <code>${result.instance.status}</code>\n` +
              `💚 <b>State:</b> Running normally\n` +
              `⏰ <b>Checked:</b> ${new Date().toLocaleString()}`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getServerKeyboard(),
            },
          );
        }
      } else {
        // Check failed
        bot.editMessageText(
          `❌ <b>VPS Health Check Failed</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
            `🔍 <b>Target:</b> <code>${vpsHost}</code>\n` +
            `❌ <b>Error:</b> ${result.message}\n\n` +
            `⏰ <b>Time:</b> ${new Date().toLocaleString()}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(
        `❌ <b>VPS Health Check Error</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Error: ${err.message}\n\n` +
          `<i>Make sure CLOUDZY_API_TOKEN is configured correctly.</i>`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        },
      );
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.1.2 VPS Manual Restart
  if (data === "server_vps_restart") {
    bot.editMessageText(
      `🔄 <b>VPS Manual Restart</b>\n━━━━━━━━━━━━━━━━━━\n\n⏳ Attempting to restart VPS via Cloudzy API...\n<i>This may take a moment...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Use the SSH host to identify the VPS
      const vpsHost = process.env.SSH_HOST || process.env.VPS_HOSTNAME;

      if (!vpsHost) {
        bot.editMessageText(
          `❌ <b>VPS Restart Failed</b>\n\nNo VPS hostname or IP configured.\nPlease set SSH_HOST or VPS_HOSTNAME in your .env file.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // First find the instance
      const findResult = await serverManager.findCloudzyInstance(vpsHost);

      if (!findResult.success) {
        bot.editMessageText(
          `❌ <b>VPS Restart Failed</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
            `🔍 <b>Target:</b> <code>${vpsHost}</code>\n` +
            `❌ <b>Error:</b> ${findResult.message}\n\n` +
            `⏰ <b>Time:</b> ${new Date().toLocaleString()}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      const instance = findResult.instance;

      // Attempt to power on/restart
      const powerOnResult = await serverManager.powerOnCloudzyInstance(
        instance.id,
      );

      if (powerOnResult.success) {
        bot.editMessageText(
          `✅ <b>VPS Restart Command Sent!</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
            `🖥️ <b>Hostname:</b> <code>${instance.hostname}</code>\n` +
            `📍 <b>IP:</b> <code>${instance.mainIp}</code>\n` +
            `✅ <b>Status:</b> Restart initiated\n\n` +
            `⏰ <b>Time:</b> ${new Date().toLocaleString()}\n\n` +
            `<i>The VPS should be back online in 1-2 minutes.</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      } else {
        // Restart failed - likely API limitation
        bot.editMessageText(
          `⚠️ <b>VPS Restart Unavailable</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
            `🖥️ <b>Hostname:</b> <code>${instance.hostname}</code>\n` +
            `📍 <b>IP:</b> <code>${instance.mainIp}</code>\n` +
            `⚠️ <b>Current Status:</b> <code>${instance.status}</code>\n\n` +
            `❌ <b>Error:</b> ${powerOnResult.message}\n\n` +
            `<i>Note: Cloudzy API poweron endpoint may not be fully implemented.\n` +
            `Please restart manually via Cloudzy dashboard if needed.</i>\n\n` +
            `⏰ <b>Time:</b> ${new Date().toLocaleString()}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(
        `❌ <b>VPS Restart Error</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Error: ${err.message}\n\n` +
          `<i>Make sure CLOUDZY_API_TOKEN is configured correctly.</i>`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getServerKeyboard(),
        },
      );
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.2 Clone Prompt (List Source Sites)
  if (data === "server_clone_prompt") {
    bot.editMessageText(`⏳ <b>Fetching Sites from Server...</b>`, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
    });

    try {
      const result = await serverManager.listSites();
      if (result.success) {
        // Get user's domains from their local domains.json
        const userDomainsData = loadDomains(chatId);

        // Extract clean base domains for comparison
        const userDomainNames = [
          ...new Set(
            userDomainsData
              .map((d) => {
                const name = getDomainFromUrl(d.name || "");
                const domain = getDomainFromUrl(d.domain || "");
                return [name, domain];
              })
              .flat()
              .filter((n) => n !== ""),
          ),
        ];

        const buttons = [];
        // Filter and create buttons for each site to select as Source
        result.sites.forEach((sitePath) => {
          const domain = path.basename(sitePath).toLowerCase();

          // Only show if the domain belongs to the user
          if (userDomainNames.includes(domain)) {
            buttons.push([
              {
                text: `📂 ${domain}`,
                callback_data: `srv_clone_src:${domain}`,
              },
            ]);
          }
        });

        if (buttons.length === 0) {
          bot.editMessageText(
            `ℹ️ <b>No sites found</b> in your domain list that can be cloned from this server.`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getServerKeyboard(),
            },
          );
          return;
        }

        buttons.push([{ text: "❌ Cancel", callback_data: "server_menu" }]);

        bot.editMessageText(
          `🚀 <b>Select Source Site</b>\n\nWhich site do you want to CLONE?`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      } else {
        bot.editMessageText(
          `❌ <b>Failed to list sites</b>\n\nError: ${result.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>System Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.3 Select Source -> Prompt for Target
  if (data.startsWith("srv_clone_src:")) {
    const sourceDomain = data.split(":")[1];

    // Security check
    if (!isDomainOwner(chatId, sourceDomain)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: This domain does not belong to you.",
        show_alert: true,
      });
      return;
    }

    userStates[chatId] = {
      step: "AWAITING_CLONE_TARGET",
      sourceDomain: sourceDomain,
    };

    bot.sendMessage(
      chatId,
      `📂 <b>Source Selected:</b> ${sourceDomain}\n\n👉 <b>Enter New Domain Name:</b>\n(e.g., new-casino.com)\n\n<i>OR Search existing Cloudflare domain:</i>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔍 Search Cloudflare Domain",
                callback_data: "cf_clone_search_prompt",
              },
            ],
            [{ text: "❌ Cancel", callback_data: "server_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.4 Search Cloudflare for Clone Target Prompt
  if (data === "cf_clone_search_prompt") {
    // Preserve source domain in state
    if (userStates[chatId] && userStates[chatId].sourceDomain) {
      userStates[chatId].step = "AWAITING_CLONE_CF_SEARCH";
      bot.sendMessage(
        chatId,
        `🔍 <b>Search Cloudflare Domain</b>\n\nEnter the domain name (or part of it) to use as the <b>TARGET</b> for cloning:`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "server_menu" }],
            ],
          },
        },
      );
    } else {
      bot.sendMessage(chatId, `❌ Session expired. Please start over.`, {
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.5 Handle Selected Clone Target from Search
  if (data.startsWith("srv_clone_target:")) {
    const targetDomain = data.split(":")[1];

    // Security check
    if (!isDomainOwner(chatId, targetDomain)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Target domain must be in your domains list.",
        show_alert: true,
      });
      return;
    }

    // Trigger the clone process logic manually
    // We simulate the text input flow by setting state and calling the handler logic
    // But since we can't easily jump to message handler, we'll duplicate the clone logic function or refactor.
    // Better: We'll just call a helper function or trigger the logic directly here.

    if (!userStates[chatId] || !userStates[chatId].sourceDomain) {
      bot.sendMessage(chatId, `❌ Session expired. Please start over.`, {
        parse_mode: "HTML",
        reply_markup: getServerKeyboard(),
      });
      return;
    }

    const sourceDomain = userStates[chatId].sourceDomain;
    const serverIp = process.env.SSH_HOST;

    bot.sendMessage(
      chatId,
      `🚀 <b>Starting Full Clone Process...</b>\n\nSource: ${sourceDomain}\nTarget: ${targetDomain}\n\n<i>1️⃣ Setting up Cloudflare...</i>`,
      { parse_mode: "HTML" },
    );

    // Execute Clone Logic (Same as text handler)
    (async () => {
      try {
        // Step 1: Cloudflare Setup
        const cfRes = await cloudflare.autoSetup(targetDomain, serverIp);
        if (!cfRes.success) {
          throw new Error(`Cloudflare Error: ${cfRes.message}`);
        }

        // [NEW] Automatic WAF Enablement
        const settings = loadSettings(chatId);
        if (settings.auto_cf_waf) {
          bot.sendMessage(
            chatId,
            `🛡️ <b>Auto-WAF:</b> Applying rules to <b>${targetDomain}</b>...`,
            { parse_mode: "HTML" },
          );
          await cloudflare.updateWafRules(
            cfRes.zoneId,
            settings.cf_waf_options,
          );
        }

        bot.sendMessage(
          chatId,
          `✅ <b>Cloudflare Setup Complete</b>\n\n<i>2️⃣ Creating Site on Server...</i>\n<code>[===>......]</code>`,
          { parse_mode: "HTML" },
        );

        // Step 2: Create Site on CloudPanel
        const createRes = await serverManager.createSite(targetDomain);
        if (!createRes.success) {
          throw new Error(`Server Site Creation Error: ${createRes.message}`);
        }

        bot.sendMessage(
          chatId,
          `✅ <b>Site Created on Server</b>\n\n<i>3️⃣ Cloning Files (This may take a moment)...</i>\n<code>[======>...]</code>`,
          { parse_mode: "HTML" },
        );

        // Step 3: Clone Files
        const cloneRes = await serverManager.cloneSiteFiles(
          sourceDomain,
          targetDomain,
        );
        if (!cloneRes.success) {
          throw new Error(`File Clone Error: ${cloneRes.message}`);
        }

        // [NEW] Install Livewire and clear caches
        let progressMsg = await bot.sendMessage(
          chatId,
          `⏳ <b>Installing Livewire & Clearing Caches...</b>\n<code>[..........]</code>`,
          { parse_mode: "HTML" },
        );

        console.log(`[CLONE] Starting Livewire install for ${targetDomain}...`);
        const livewireRes = await serverManager.execCommand(
          `cd ${cloneRes.target}/base && composer require livewire/livewire --no-interaction`,
        );
        console.log(
          `[CLONE] Livewire install result: ${livewireRes.success ? "SUCCESS" : "FAILED"}`,
          livewireRes.error || livewireRes.output,
        );
        await bot.editMessageText(
          `⏳ <b>Installing Livewire & Clearing Caches...</b>\n✅ Livewire: ${livewireRes.success ? "Installed" : "Failed"}\n<code>[==>.......]</code>`,
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: "HTML",
          },
        );

        console.log(`[CLONE] Running route:clear for ${targetDomain}...`);
        const routeClearRes = await serverManager.execCommand(
          `cd ${cloneRes.target}/base && php artisan route:clear`,
        );
        console.log(
          `[CLONE] route:clear result: ${routeClearRes.success ? "SUCCESS" : "FAILED"}`,
          routeClearRes.error || routeClearRes.output,
        );
        await bot.editMessageText(
          `⏳ <b>Installing Livewire & Clearing Caches...</b>\n✅ Livewire: ${livewireRes.success ? "Installed" : "Failed"}\n✅ Route Clear: ${routeClearRes.success ? "Done" : "Failed"}\n<code>[====>.....]</code>`,
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: "HTML",
          },
        );

        console.log(`[CLONE] Running config:clear for ${targetDomain}...`);
        const configClearRes = await serverManager.execCommand(
          `cd ${cloneRes.target}/base && php artisan config:clear`,
        );
        console.log(
          `[CLONE] config:clear result: ${configClearRes.success ? "SUCCESS" : "FAILED"}`,
          configClearRes.error || configClearRes.output,
        );
        await bot.editMessageText(
          `⏳ <b>Installing Livewire & Clearing Caches...</b>\n✅ Livewire: ${livewireRes.success ? "Installed" : "Failed"}\n✅ Route Clear: ${routeClearRes.success ? "Done" : "Failed"}\n✅ Config Clear: ${configClearRes.success ? "Done" : "Failed"}\n<code>[======>...]</code>`,
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: "HTML",
          },
        );

        console.log(`[CLONE] Running cache:clear for ${targetDomain}...`);
        const cacheClearRes = await serverManager.execCommand(
          `cd ${cloneRes.target}/base && php artisan cache:clear`,
        );
        console.log(
          `[CLONE] cache:clear result: ${cacheClearRes.success ? "SUCCESS" : "FAILED"}`,
          cacheClearRes.error || cacheClearRes.output,
        );
        await bot.editMessageText(
          `⏳ <b>Installing Livewire & Clearing Caches...</b>\n✅ Livewire: ${livewireRes.success ? "Installed" : "Failed"}\n✅ Route Clear: ${routeClearRes.success ? "Done" : "Failed"}\n✅ Config Clear: ${configClearRes.success ? "Done" : "Failed"}\n✅ Cache Clear: ${cacheClearRes.success ? "Done" : "Failed"}\n<code>[==========]</code>`,
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: "HTML",
          },
        );

        if (!livewireRes.success) {
          console.error("Livewire install failed:", livewireRes.error);
        }

        // Step 4: Detect Admin Prefix from the newly cloned files
        let adminPath = "admin"; // Default
        const prefixRes = await serverManager.getAdminPrefix(targetDomain);
        if (prefixRes.success) {
          adminPath = prefixRes.prefix;
        }

        // Step 5: Add Cron Job (Run every 5 minutes) via cron-job.org
        bot.sendMessage(
          chatId,
          `⏳ <b>Finalizing Clone...</b>\n\n<i>4️⃣ Setting up cron job (cron-job.org)...</i>`,
          { parse_mode: "HTML" },
        );

        const cronUrl = `https://${targetDomain}/getcronhaha`;
        const cronTitle = `Cron for ${targetDomain}`;

        // First check if it exists
        const existingJobRes =
          await serverManager.cronJobOrg.findJobByUrl(cronUrl);
        if (existingJobRes.success && existingJobRes.job) {
          console.log(
            `Cron job already exists for ${targetDomain} on cron-job.org`,
          );
        } else {
          const cronRes = await serverManager.cronJobOrg.createJob(
            cronTitle,
            cronUrl,
          );
          if (!cronRes.success) {
            console.error(
              `Cron-job.org setup failed for ${targetDomain}:`,
              cronRes.message,
            );
          }
        }

        // Also keep local crontab as backup
        const localCronCommand = `*/5 * * * * curl -s https://${targetDomain}/getcronhaha`;
        await serverManager.addCronJob(
          targetDomain,
          createRes.siteUser,
          localCronCommand,
        );

        bot.sendMessage(
          chatId,
          `🎉 <b>CLONE SUCCESSFUL!</b>\n<code>[==========]</code>\n\n✅ Domain Added to Cloudflare\n✅ Site Created in CloudPanel\n✅ Files Copied from ${sourceDomain}\n✅ Permissions Fixed\n✅ Cron Job Active\n\n🌐 <b>Live URL:</b> https://${targetDomain}\n🔐 <b>Admin URL:</b> https://${targetDomain}/${adminPath}/login\n⚙️ <b>Default Admin:</b> https://${targetDomain}/admin/login`,
          {
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );

        // [NEW] Automatically add cloned domain to domains.json with clone_group_id
        const currentDomains = loadDomains(chatId);
        const newDomainUrl = `https://${targetDomain}/api`;
        const exists = currentDomains.some((d) => d.url === newDomainUrl);
        
        if (!exists) {
          // Find the source domain to get its clone_group_id
          const sourceDomainData = currentDomains.find(d => 
            getDomainFromUrl(d.url) === sourceDomain || 
            getDomainFromUrl(d.name) === sourceDomain
          );
          
          const newDomain = {
            name: targetDomain,
            url: newDomainUrl,
            has_merchant: false,
          };
          
          // If source has a clone_group_id, use it; otherwise create a new group
          if (sourceDomainData) {
            if (sourceDomainData.clone_group_id) {
              // Join existing clone group
              newDomain.clone_group_id = sourceDomainData.clone_group_id;
              newDomain.is_primary = false; // Cloned domain is not primary
            } else {
              // Source doesn't have a group yet - create one
              const newGroupId = generateCloneGroupId();
              
              // Update source domain to be primary of new group
              const sourceIndex = currentDomains.findIndex(d => d === sourceDomainData);
              if (sourceIndex !== -1) {
                currentDomains[sourceIndex].clone_group_id = newGroupId;
                currentDomains[sourceIndex].is_primary = true;
                saveDomains(chatId, currentDomains);
              }
              
              // Set cloned domain as member of group
              newDomain.clone_group_id = newGroupId;
              newDomain.is_primary = false;
            }
            
            console.log(`[AUTO_ADD_CLONE] Added ${targetDomain} to clone group ${newDomain.clone_group_id}`);
          }
          
          saveDomain(chatId, newDomain);
          
          bot.sendMessage(
            chatId,
            `✅ <b>Domain Auto-Added</b>\n\n📎 <code>${targetDomain}</code> has been added to your domains list as a clone of <code>${sourceDomain}</code>.`,
            { parse_mode: "HTML" }
          );
        }
      } catch (err) {
        bot.sendMessage(
          chatId,
          `❌ <b>Process Failed</b>\n\nStopped at error: ${err.message}`,
          {
            parse_mode: "HTML",
            reply_markup: getServerKeyboard(),
          },
        );
      }
    })();

    delete userStates[chatId];
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.6 Create New Site Prompt
  if (data === "server_create_site_prompt") {
    userStates[chatId] = { step: "AWAITING_CREATE_SITE_DOMAIN" };
    bot.sendMessage(
      chatId,
      `🆕 <b>Create New PHP Site</b>\n\nEnter the <b>Domain Name</b> you want to create on the server:\n(e.g., my-new-game.com)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "server_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // --- Dynadot Menu ---
  if (data === "dynadot_menu") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }
    bot.editMessageText(
      `🌐 <b>Dynadot Tools</b>\n━━━━━━━━━━━━━━━━━━\nManage your Dynadot account and domains.\n\n<b>Balance:</b> Check account credit\n<b>Buy:</b> Register domains instantly\n<b>DNS:</b> Manage nameservers`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getDynadotKeyboard(),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Dynadot: Check Balance
  if (data === "dd_check_balance") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }
    bot.sendMessage(chatId, `⏳ <b>Checking Balance...</b>`, {
      parse_mode: "HTML",
    });
    try {
      const balance = await dynadot.getBalance();
      bot.sendMessage(chatId, `💰 <b>Dynadot Balance:</b> $${balance}`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Dynadot: Check Domain Availability (Prompt)
  if (data === "dd_check_domain") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }
    userStates[chatId] = { step: "AWAITING_DD_DOMAIN_CHECK" };
    bot.sendMessage(
      chatId,
      `🔍 <b>Check Availability</b>\n\nEnter the domain name to check:\n(e.g., <code>example.com</code>)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "dynadot_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Dynadot: Buy Domain (Prompt)
  if (data === "dd_buy_domain") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }
    userStates[chatId] = { step: "AWAITING_DD_DOMAIN_BUY" };
    bot.sendMessage(
      chatId,
      `🛒 <b>Buy New Domain</b>\n\n⚠️ <b>Payment:</b> Account Balance\n\nEnter the domain name to register:\n(e.g., <code>newproject.com</code>)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "dynadot_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Dynadot: Update DNS (Prompt)
  if (data === "dd_update_dns") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }

    // Get user's domains and search each one at Dynadot
    const userDomains = loadDomains(chatId);
    if (userDomains.length === 0) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ No domains in your list.",
        show_alert: true,
      });
      return;
    }

    bot.editMessageText(
      `⏳ <b>Searching Dynadot...</b>\n<i>Checking ${userDomains.length} domains to find your Dynadot domains...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);

    // Search each domain at Dynadot to verify ownership
    const searchPromises = userDomains.map(async (d) => {
      const domainName = d.name || d.domain;
      try {
        const result = await dynadot.searchDomain(domainName);
        // If search returns results and domain is not available (meaning it's registered)
        if (Array.isArray(result) && result.length > 0) {
          const domainResult = result.find((r) => r.domain === domainName);
          if (domainResult && !domainResult.available) {
            // Domain exists at Dynadot (not available means registered)
            return { domain: domainName, atDynadot: true };
          }
        }
        return { domain: domainName, atDynadot: false };
      } catch (e) {
        return { domain: domainName, atDynadot: false };
      }
    });

    Promise.all(searchPromises)
      .then((results) => {
        const dynadotDomains = results
          .filter((r) => r.atDynadot)
          .map((r) => r.domain);

        if (dynadotDomains.length === 0) {
          bot.editMessageText(
            `❌ <b>No Dynadot Domains Found</b>\n\nNone of your saved domains appear to be registered at Dynadot.\n\n<i>Note: This search checks if domains are unavailable at Dynadot (registered). If you have domains at Dynadot, make sure they're saved in your domain list.</i>`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getDynadotKeyboard(),
            },
          );
          return;
        }

        // Create buttons for Dynadot domains
        const buttons = [];
        for (let i = 0; i < dynadotDomains.length; i += 2) {
          const row = [];
          row.push({
            text: `🌐 ${dynadotDomains[i]}`,
            callback_data: `dd_dns_domain:${dynadotDomains[i]}`,
          });

          if (dynadotDomains[i + 1]) {
            row.push({
              text: `🌐 ${dynadotDomains[i + 1]}`,
              callback_data: `dd_dns_domain:${dynadotDomains[i + 1]}`,
            });
          }
          buttons.push(row);
        }

        buttons.push([{ text: "❌ Cancel", callback_data: "dynadot_menu" }]);

        bot.editMessageText(
          `📡 <b>Update Nameservers</b>\n\nFound <b>${dynadotDomains.length}</b> Dynadot domain(s):\n<i>Select one to update nameservers:</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          },
        );
      })
      .catch((err) => {
        bot.editMessageText(
          `❌ <b>Error</b>\n\nFailed to search domains: ${err.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getDynadotKeyboard(),
          },
        );
      });

    return;
  }

  // Dynadot: DNS Domain Selected
  if (data.startsWith("dd_dns_domain:")) {
    const domain = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_DD_DNS_NS", domain: domain };
    bot.sendMessage(
      chatId,
      `📝 <b>Enter Nameservers</b>\n\nFor <b>${domain}</b>, please enter the nameservers separated by commas:\n(e.g., <code>ns1.cloudflare.com, ns2.cloudflare.com</code>)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "dd_update_dns" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Dynadot: Confirm Buy
  if (data.startsWith("dd_confirm_buy:")) {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access Dynadot tools.",
        show_alert: true,
      });
      return;
    }
    const domain = data.split(":")[1];
    bot.sendMessage(
      chatId,
      `⏳ <b>Registering ${domain}...</b>\n\n<i>Processing payment from account balance...</i>`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await dynadot.registerDomain(domain);
      if (result.success) {
        let msg = `🎉 <b>REGISTRATION SUCCESSFUL!</b>\n\n✅ <b>Domain:</b> ${domain}\n✅ <b>Expiration:</b> ${new Date(result.expiration).toDateString()}\n\n`;

        // Auto Nameservers
        // Assuming Cloudflare or user default
        // Default Nameservers: NS1.CLOUDFLARE.COM, NS2.CLOUDFLARE.COM
        const ns = ["ns1.cloudflare.com", "ns2.cloudflare.com"];
        msg += `⏳ <b>Setting Nameservers...</b>\n<i>${ns.join(", ")}</i>\n\n`;

        const nsRes = await dynadot.setNameservers(domain, ns);
        if (nsRes.success) {
          msg += `✅ Nameservers Updated!`;
        } else {
          msg += `⚠️ Nameserver Update Failed: ${nsRes.message}`;
        }

        bot.sendMessage(chatId, msg, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
            ],
          },
        });
      } else {
        bot.sendMessage(
          chatId,
          `❌ <b>Registration Failed</b>\n\nReason: ${result.message}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back to Menu", callback_data: "dynadot_menu" }],
              ],
            },
          },
        );
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ System Error: ${err.message}`);
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8.10 Upload Prompt Handling
  if (
    data.startsWith("srv_upload_zip:") ||
    data.startsWith("srv_upload_sql:")
  ) {
    const type = data.includes("zip") ? "zip" : "sql";
    const domain = data.split(":")[1];

    userStates[chatId] = {
      step: type === "zip" ? "AWAITING_ZIP_UPLOAD" : "AWAITING_SQL_UPLOAD",
      domain: domain,
    };

    const fileType =
      type === "zip" ? "Project Files (.zip)" : "Database Backup (.sql)";

    bot.sendMessage(
      chatId,
      `📤 <b>Upload ${fileType}</b>\n\nPlease <b>drag and drop</b> your <code>.${type}</code> file here for <b>${domain}</b>.\n\n💡 <b>Tip:</b> If your file is larger than 20MB, please upload it to the <code>/deploy</code> folder on this server via SFTP first, then use the <b>Local Deploy</b> option.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "server_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 9. Document/File Handler
  if (msg.document) {
    const state = userStates[chatId];
    if (!state) return;

    // Handle ZIP Upload
    if (state.step === "AWAITING_ZIP_UPLOAD") {
      const fileName = msg.document.file_name;
      const fileSize = msg.document.file_size;

      // Telegram Bot API Limit Check (20MB)
      if (fileSize > 20 * 1024 * 1024) {
        bot.sendMessage(
          chatId,
          `⚠️ <b>File Too Large (${(fileSize / (1024 * 1024)).toFixed(2)}MB)</b>\n\nTelegram restricts direct uploads to <b>20MB</b>.\n\n🚀 <b>Solution:</b>\n1. Upload your file to: <code>${path.join(__dirname, "deploy")}</code>\n2. Go back to <b>Server Menu</b>\n3. Select <b>Local Deploy</b>`,
          { parse_mode: "HTML" },
        );
        return;
      }

      if (!fileName.endsWith(".zip")) {
        bot.sendMessage(
          chatId,
          `⚠️ <b>Invalid File</b>\nPlease upload a <b>.zip</b> file.`,
        );
        return;
      }

      bot.sendMessage(
        chatId,
        `⏳ <b>Downloading & Deploying...</b>\n<i>This may take a minute...</i>`,
        { parse_mode: "HTML" },
      );

      try {
        // 1. Download from Telegram
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const localPath = path.join(__dirname, fileName);

        const response = await axios({ url: fileLink, responseType: "stream" });
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        // 2. Upload to Server (via SFTP/SCP logic manually or just use stream? SSH2 has sftp)
        // We'll implement a simple SFTP put here using the existing serverManager config
        const { Client } = require("ssh2");
        const conn = new Client();

        const remotePath = `/tmp/${fileName}`;

        await new Promise((resolve, reject) => {
          conn
            .on("ready", () => {
              conn.sftp((err, sftp) => {
                if (err) {
                  conn.end();
                  reject(err);
                  return;
                }

                sftp.fastPut(localPath, remotePath, (err) => {
                  conn.end();
                  if (err) reject(err);
                  else resolve();
                });
              });
            })
            .connect({
              host: process.env.SSH_HOST,
              port: 22,
              username: process.env.SSH_USER,
              password: process.env.SSH_PASS,
            });
        });

        // 3. Deploy on Server with progress updates
        let deployProgressMsg = await bot.sendMessage(
          chatId,
          `⏳ <b>Deploying...</b>\n<code>[..........]</code>`,
          { parse_mode: "HTML" },
        );

        const deployRes = await serverManager.deployZip(
          state.domain,
          remotePath,
          async (status) => {
            // Progress callback - update Telegram message
            await bot.editMessageText(
              `⏳ <b>Deploying...</b>\n${status}\n<code>[==========]</code>`,
              {
                chat_id: chatId,
                message_id: deployProgressMsg.message_id,
                parse_mode: "HTML",
              },
            );
          },
        );

        // Final update with all results
        const livewireStatus = deployRes.livewire
          ? "✅ Installed"
          : "❌ Failed";
        await bot.editMessageText(
          `✅ <b>Deploy Complete!</b>\n\n📦 Unzipped: ${deployRes.success ? "✅" : "❌"}\n🔧 Livewire: ${livewireStatus}\n🧹 Routes Cleared\n🧹 Config Cleared\n🧹 Cache Cleared\n🔐 Permissions Set`,
          {
            chat_id: chatId,
            message_id: deployProgressMsg.message_id,
            parse_mode: "HTML",
          },
        );

        // Cleanup local file
        fs.unlinkSync(localPath);

        if (deployRes.success) {
          bot.sendMessage(
            chatId,
            `✅ <b>Files Deployed!</b>\n\nExtracted to: <code>${deployRes.sitePath}</code>\nPermissions Fixed.`,
            { parse_mode: "HTML" },
          );
        } else {
          bot.sendMessage(
            chatId,
            `❌ <b>Deployment Failed</b>\nError: ${deployRes.message}`,
            { parse_mode: "HTML" },
          );
        }
      } catch (err) {
        bot.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`, {
          parse_mode: "HTML",
        });
      }
      delete userStates[chatId];
      return;
    }

    // Handle SQL Upload
    if (state.step === "AWAITING_SQL_UPLOAD") {
      const fileName = msg.document.file_name;
      if (!fileName.endsWith(".sql")) {
        bot.sendMessage(
          chatId,
          `⚠️ <b>Invalid File</b>\nPlease upload a <b>.sql</b> file.`,
        );
        return;
      }

      bot.sendMessage(
        chatId,
        `⏳ <b>Importing Database...</b>\n<i>Creating DB & Injecting SQL...</i>`,
        { parse_mode: "HTML" },
      );

      try {
        // 1. Download
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const localPath = path.join(__dirname, fileName);

        const response = await axios({ url: fileLink, responseType: "stream" });
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        // 2. Upload to Server
        const { Client } = require("ssh2");
        const conn = new Client();
        const remotePath = `/tmp/${fileName}`;

        await new Promise((resolve, reject) => {
          conn
            .on("ready", () => {
              conn.sftp((err, sftp) => {
                if (err) {
                  conn.end();
                  reject(err);
                  return;
                }
                sftp.fastPut(localPath, remotePath, (err) => {
                  conn.end();
                  if (err) reject(err);
                  else resolve();
                });
              });
            })
            .connect({
              host: process.env.SSH_HOST,
              port: 22,
              username: process.env.SSH_USER,
              password: process.env.SSH_PASS,
            });
        });

        // 3. Create DB & Import
        // Generate secure credentials
        const dbName =
          state.domain.replace(/[^a-z0-9]/g, "").substring(0, 10) +
          "_" +
          Math.random().toString(36).slice(-4);
        const dbUser = dbName;
        const dbPass = Math.random().toString(36).slice(-10) + "!";

        // Create DB
        const createDbRes = await serverManager.createDatabase(
          state.domain,
          dbName,
          dbUser,
          dbPass,
        );
        if (!createDbRes.success)
          throw new Error(`DB Create Failed: ${createDbRes.message}`);

        // Import SQL
        const importRes = await serverManager.importSql(
          dbName,
          dbUser,
          dbPass,
          remotePath,
        );
        if (!importRes.success)
          throw new Error(`Import Failed: ${importRes.message}`);

        // 4. Update .env file
        const envRes = await serverManager.updateEnvFile(
          state.domain,
          dbName,
          dbUser,
          dbPass,
        );

        // Cleanup local
        fs.unlinkSync(localPath);

        bot.sendMessage(
          chatId,
          `✅ <b>Database Deployed!</b>\n\nDB Name: <code>${dbName}</code>\nUser: <code>${dbUser}</code>\nPass: <code>${dbPass}</code>\n\n🔄 <b>.env Updated:</b> ${envRes.success ? "Yes" : "No (Check manually)"}`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        bot.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`, {
          parse_mode: "HTML",
        });
      }
      delete userStates[chatId];
      return;
    }
  }

  // 7. My Domains List & Filter
  if (data.startsWith("nc_list:")) {
    const type = data.split(":")[1]; // all, active, expired, blocked
    if (userStates[chatId]) delete userStates[chatId];

    let filterTitle = "All";
    if (type === "active") filterTitle = "Active";
    if (type === "expired") filterTitle = "Expired";
    if (type === "blocked") filterTitle = "Blocked/Alert";

    bot.editMessageText(
      `⏳ <b>Fetching ${filterTitle} Domains...</b>\n<i>Please wait...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Get user's tracked domains from local domains.json
      const userDomainsData = loadDomains(chatId);
      const trackedDomains = userDomainsData
        .map((d) => (d.name || d.domain || "").toLowerCase())
        .filter((n) => n !== "");

      if (trackedDomains.length === 0) {
        bot.editMessageText(
          `ℹ️ <b>No tracked domains found.</b>\n\nYou haven't added any domains to your list yet.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getNamecheapKeyboard(),
          },
        );
        bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Fetch first 100 domains from Namecheap API
      const result = await namecheap.getOwnedDomains(1, 100);

      if (result.success && result.domains.length > 0) {
        // Filter Namecheap API results to only include those in user's trackedDomains list
        const userOwnedDomains = result.domains.filter((d) =>
          trackedDomains.includes(d.name.toLowerCase()),
        );

        if (userOwnedDomains.length === 0) {
          bot.editMessageText(
            `📂 <b>My Domains</b>\n\nNone of your <b>${trackedDomains.length}</b> tracked domains were found in the recent 100 Namecheap domains.`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getNamecheapKeyboard(),
            },
          );
          bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        let filteredDomains = userOwnedDomains;

        // Helper to check blocked status
        const isBlocked = (d) => d.isLocked || d.whoisGuard === "AlertBlocked";

        // Apply Client-Side Filtering on the user's domains
        if (type === "active") {
          filteredDomains = userOwnedDomains.filter(
            (d) => !d.isExpired && !isBlocked(d),
          );
        } else if (type === "expired") {
          filteredDomains = userOwnedDomains.filter((d) => d.isExpired);
        } else if (type === "blocked") {
          filteredDomains = userOwnedDomains.filter((d) => isBlocked(d));
        }

        // Statistics (based ONLY on user's tracked domains)
        const totalCount = userOwnedDomains.length;
        const activeCount = userOwnedDomains.filter(
          (d) => !d.isExpired && !isBlocked(d),
        ).length;
        const expiredCount = userOwnedDomains.filter((d) => d.isExpired).length;
        const blockedCount = userOwnedDomains.filter((d) =>
          isBlocked(d),
        ).length;

        if (filteredDomains.length > 0) {
          const buttons = [];
          // Limit display to 50 buttons max to avoid Telegram limits
          const displayLimit = 50;
          const toDisplay = filteredDomains.slice(0, displayLimit);

          for (let i = 0; i < toDisplay.length; i += 2) {
            const row = [];

            const getIcon = (d) => {
              if (isBlocked(d)) return "🚫";
              if (d.isExpired) return "❌";
              return "✅";
            };

            row.push({
              text: `${getIcon(toDisplay[i])} ${toDisplay[i].name}`,
              callback_data: `nc_manage:${toDisplay[i].name}`,
            });
            if (toDisplay[i + 1]) {
              row.push({
                text: `${getIcon(toDisplay[i + 1])} ${toDisplay[i + 1].name}`,
                callback_data: `nc_manage:${toDisplay[i + 1].name}`,
              });
            }
            buttons.push(row);
          }

          buttons.push([
            { text: "⬅️ Back to Tools", callback_data: "namecheap_menu" },
          ]);

          bot.editMessageText(
            `📂 <b>My Domains (${filteredDomains.length} shown)</b>\n\n📊 Tracked: ${totalCount}\n✅ Active: ${activeCount}\n❌ Expired: ${expiredCount}\n🚫 Blocked: ${blockedCount}\n\nSelect a domain to manage:`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buttons },
            },
          );
        } else {
          bot.editMessageText(
            `📂 <b>My Domains</b>\n\nNo ${type} domains found among your <b>${totalCount}</b> tracked domains.`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getNamecheapKeyboard(),
            },
          );
        }
      } else {
        bot.editMessageText(
          `📂 <b>My Domains</b>\n\nNo domains found in this account.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getNamecheapKeyboard(),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ Error fetching domains: ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getNamecheapKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 7.5 Search Prompt
  if (data === "nc_search_prompt") {
    userStates[chatId] = { step: "AWAITING_MY_DOMAIN_SEARCH" };
    bot.sendMessage(
      chatId,
      `🔍 <b>Search My Domains</b>\n\nPlease enter a keyword (e.g., "casino", "shop") to search your domain list:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "namecheap_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 8. Manage Specific Domain
  if (data.startsWith("nc_manage:")) {
    const domainName = data.split(":")[1];

    bot.editMessageText(`⏳ <b>Fetching Details for ${domainName}...</b>`, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
    });

    try {
      // Fetch fresh details for this domain
      const result = await namecheap.getOwnedDomains(1, 10, domainName);

      if (result.success && result.domains.length > 0) {
        const d = result.domains[0];

        // Determine Status
        let status = "✅ Active";
        if (d.isExpired) status = "❌ Expired";
        if (d.isLocked) status = "🔒 Locked";
        if (d.whoisGuard === "AlertBlocked") status = "🚫 BLOCKED (Alert)";

        const info = `
⚙️ <b>Manage Domain</b>
━━━━━━━━━━━━━━━━━━
📌 <b>Domain:</b> ${d.name}
📊 <b>Status:</b> ${status}
📅 <b>Expires:</b> ${d.expires}
🛡️ <b>WhoisGuard:</b> ${d.whoisGuard}
🔒 <b>Locked:</b> ${d.isLocked ? "Yes" : "No"}
🔄 <b>Auto-Renew:</b> ${d.autoRenew ? "On" : "Off"}
`;
        bot.editMessageText(info, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getDomainManageKeyboard(domainName),
        });
      } else {
        bot.editMessageText(`❌ <b>Error:</b> Domain details not found.`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getNamecheapKeyboard(),
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>System Error:</b> ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getNamecheapKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 9. Change DNS Menu
  if (data.startsWith("nc_dns:")) {
    const domain = data.split(":")[1];

    bot.editMessageText(
      `📡 <b>DNS Configuration:</b> ${domain}\n\nSelect a preset or enter custom nameservers:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "☁️ Cloudflare",
                callback_data: `nc_dns_set:cf:${domain}`,
              },
            ],
            [
              {
                text: "✏️ Custom Input",
                callback_data: `nc_dns_input:${domain}`,
              },
            ],
            [{ text: "⬅️ Back", callback_data: `nc_manage:${domain}` }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 9.1 Set Preset DNS
  if (data.startsWith("nc_dns_set:")) {
    const parts = data.split(":");
    const preset = parts[1];
    const domain = parts[2];

    let nameservers = [];
    if (preset === "cf") {
      bot.editMessageText(`⏳ <b>Fetching Cloudflare Nameservers...</b>`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      });

      try {
        // 1. Try to get existing zone
        const cfZone = await cloudflare.getZoneId(domain);

        if (cfZone.success && cfZone.nameservers) {
          nameservers = cfZone.nameservers;
        } else {
          // 2. If not found, try to add zone
          const addRes = await cloudflare.addZone(domain);
          if (addRes.success && addRes.nameservers) {
            nameservers = addRes.nameservers;
          } else {
            throw new Error(
              "Could not find or create Cloudflare zone for this domain.",
            );
          }
        }
      } catch (err) {
        bot.editMessageText(`❌ <b>Error:</b> ${err.message}`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getDomainManageKeyboard(domain),
        });
        return;
      }
    }

    bot.editMessageText(
      `⏳ <b>Updating DNS for ${domain}...</b>\n\nTarget: ${preset.toUpperCase()}\nNameservers: <code>${nameservers.join(", ")}</code>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      const result = await namecheap.setNameservers(domain, nameservers);
      if (result.success && result.updated) {
        bot.editMessageText(
          `✅ <b>DNS Updated Successfully!</b>\n\nDomain: <b>${domain}</b>\nNameservers: <code>${nameservers.join(", ")}</code>\n\n<i>Propagation: 24-48h</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getDomainManageKeyboard(domain),
          },
        );
      } else {
        bot.editMessageText(
          `❌ <b>Update Failed</b>\n\nReason: ${result.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getDomainManageKeyboard(domain),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ Error: ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getDomainManageKeyboard(domain),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 9.2 Custom Input Prompt
  if (data.startsWith("nc_dns_input:")) {
    const domain = data.split(":")[1];
    userStates[chatId] = { step: "AWAITING_DNS_INPUT", domainName: domain };

    bot.editMessageText(
      `📡 <b>Custom DNS for ${domain}</b>\n\nPlease enter 2+ nameservers separated by commas/spaces:\n\nExample:\n<code>ns1.example.com, ns2.example.com</code>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: `nc_dns:${domain}` }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // --- Namecheap Buy Domain Flow ---
  if (data === "buy_new_domain") {
    userStates[chatId] = { step: "AWAITING_DOMAIN_NAME" };
    bot.sendMessage(
      chatId,
      `🌐 <b>Buy New Domain</b>\n\nEnter a <b>Keyword</b> for bulk search (e.g., <code>ag-l</code>) or a <b>Full Domain</b> to check specific availability (e.g., <code>ag-l.space</code>):`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Cancel", callback_data: "main_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Handle Bulk Selection
  if (data.startsWith("sel_dom:")) {
    const parts = data.split(":");
    const domainName = parts[1];
    const price = parts[2];

    userStates[chatId] = {
      step: "CONFIRM_PURCHASE",
      domainName: domainName,
      price: price,
      premium: false,
    };

    bot.sendMessage(
      chatId,
      `🎯 <b>Selected Domain:</b> <b>${domainName}</b>\n💰 Price: <b>${price}</b>\n\nDo you want to proceed with registration?`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Confirm Purchase",
                callback_data: "confirm_purchase",
              },
            ],
            [{ text: "❌ Cancel", callback_data: "main_menu" }],
          ],
        },
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (data === "confirm_purchase") {
    if (!userStates[chatId] || userStates[chatId].step !== "CONFIRM_PURCHASE") {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "Session expired",
        show_alert: true,
      });
      return;
    }

    const domainName = userStates[chatId].domainName;
    const priceStr = userStates[chatId].price || "0";
    const cost = parseFloat(priceStr.replace("$", ""));

    bot.editMessageText(
      `⏳ <b>Registering Domain...</b>\n<i>Please wait, this may take a few seconds...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    try {
      // Final balance check before registration
      const balanceRes = await namecheap.getBalances();
      if (balanceRes.success) {
        const balance = parseFloat(balanceRes.availableBalance);
        if (balance < cost) {
          bot.editMessageText(
            `❌ <b>Insufficient Funds</b>\n\nYour balance ($${balanceRes.availableBalance}) is lower than the domain price ($${cost}).\n\nPlease top up your Namecheap account.`,
            {
              chat_id: chatId,
              message_id: msg.message_id,
              parse_mode: "HTML",
              reply_markup: getDomainKeyboard(chatId),
            },
          );
          delete userStates[chatId];
          bot.answerCallbackQuery(callbackQuery.id);
          return;
        }
      }

      const result = await namecheap.registerDomain(domainName);

      if (result.success && result.registered) {
        bot.editMessageText(
          `✅ <b>Registration Successful!</b>\n\n📌 Domain: <b>${result.domain}</b>\n🆔 TransID: ${result.transactionId}\n💰 Charged: $${result.chargedAmount}\n\n⚙️ <b>Next Step:</b> Configure your domain DNS.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📡 Set Custom DNS (Nameservers)",
                    callback_data: `nc_dns:${result.domain}`,
                  },
                ],
                [
                  {
                    text: "📂 Manage Domain",
                    callback_data: `nc_manage:${result.domain}`,
                  },
                ],
                [{ text: "🏠 Main Menu", callback_data: "main_menu" }],
              ],
            },
          },
        );
      } else {
        bot.editMessageText(
          `❌ <b>Registration Failed</b>\n\nReason: ${result.message}`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: getDomainKeyboard(chatId),
          },
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ <b>System Error</b>\n\n${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getDomainKeyboard(chatId),
      });
    }
    delete userStates[chatId];
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Developer Withdraw Menu - Direct to Default Domain
  if (data === "dev_withdraw_menu") {
    // Additional security layer: Check if user is authorized developer
    const userId = callbackQuery.from.id;
    const devId = parseInt(process.env.DEVELOPER_CHAT_ID) || 8304942533;
    if (userId !== devId) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied. Unauthorized.",
        show_alert: true,
      });
      return;
    }

    const domains = loadDomains(chatId);
    // Default to 'Live Site' or first domain with merchant, or just first domain
    let index = domains.findIndex((d) => d.name === "Live Site");
    if (index === -1) index = domains.findIndex((d) => d.has_merchant === true);
    if (index === -1) index = 0;

    const domain = domains[index];

    if (!domain) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "No domains found for this user",
        show_alert: true,
      });
      return;
    }

    let lastUpdateTime = 0;
    const updateProgress = (name, success, sCount, fCount, fDomains) => {
      const now = Date.now();
      // Update every 1.5s or on final domain
      if (now - lastUpdateTime < 1500 && sCount + fCount < domains.length)
        return;
      lastUpdateTime = now;

      // Get clone group info
      const { groups } = getDomainsByCloneGroup(chatId);
      const groupCount = Object.keys(groups).length;
      const cloneInfo = groupCount > 0 ? `\n<i>📊 ${groupCount} clone groups detected</i>` : "";

      let txt = `⏳ <b>Calculating Total Balance...</b>${cloneInfo}\n<i>Fetching data from ${domains.length} domains...</i>\n\n✅ Live: ${sCount}\n❌ Unreachable: ${fCount}`;
      if (fDomains.length > 0) {
        const showList = fDomains.slice(0, 5);
        txt +=
          `\n\n<b>Failed:</b>\n` + showList.map((d) => `• ${d}`).join("\n");
        if (fDomains.length > 5) txt += `\n...and ${fDomains.length - 5} more`;
      }

      bot
        .editMessageText(txt, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
        })
        .catch(() => {});
    };

    try {
      // Get Aggregate Balance for this user
      const balances = await getTotalBalance(chatId, updateProgress);
      const adminFormatted = balances.admin.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const merchantFormatted = balances.merchant.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const totalFormatted = balances.total.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

      // Get developer_id from the selected domain
      let devIdFromApi = 1;
      try {
        const api = getApi(domain.url);
        const response = await api.get("/system-info");
        if (response.data.success) {
          devIdFromApi = response.data.data.developer_id || 1;
        }
      } catch (e) {
        // Silently fail if system-info is unreachable, default to 1
      }

      userStates[chatId] = {
        step: "WITHDRAW_AWAITING_AMOUNT",
        domainIndex: index,
        developer_id: devIdFromApi,
        available_balance: balances.total,
        payment_type: "1721",
        account_name: "m. s",
        account_number: "09635995458",
      };

      bot.editMessageText(
        `💰 <b>Withdrawal Summary (DEV)</b>\n━━━━━━━━━━━━━━━━━━\n🏦 Total Merchant: <b>₱${merchantFormatted}</b>\n🏛️ Total Site Balance: <b>₱${adminFormatted}</b>\n──────────────────\n✨ <b>OWNER EARNING: ₱${totalFormatted}</b>\n━━━━━━━━━━━━━━━━━━\n\nProcessing via: <b>${domain.name}</b>\n\n🔢 Please enter the <b>AMOUNT</b> to withdraw:\n(Default: Maya2, m. s, 09635995458)`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "main_menu" }],
            ],
          },
        },
      );
    } catch (err) {
      bot.editMessageText(`❌ Calculation Error: ${err.message}`, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      });
    }
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Backup Menu
  if (data === "backup_menu") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access backup functions.",
        show_alert: true,
      });
      return;
    }
    // Add current user to subscribers
    subscribedUsers.add(chatId);

    const isAuto = autoBackupInterval !== null;
    bot.editMessageText(
      `🗄️ <b>Backup Manager</b>\n━━━━━━━━━━━━━━━━━━\nAuto-Backup: <b>${isAuto ? "✅ ON (Every 5m)" : "🛑 OFF"}</b>\n\nSelect a backup option below:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getBackupKeyboard(isAuto, chatId),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Toggle Auto Backup
  if (data === "toggle_auto_backup") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access backup functions.",
        show_alert: true,
      });
      return;
    }
    const isAuto = autoBackupInterval !== null;

    if (isAuto) {
      stopAutoBackup();
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "Auto-Backup Disabled",
      });
    } else {
      subscribedUsers.add(chatId); // Ensure toggler is subscribed
      startAutoBackup();
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "Auto-Backup Enabled (5 min)",
      });
    }

    const newStatus = !isAuto;
    bot.editMessageText(
      `🗄️ <b>Backup Manager</b>\n━━━━━━━━━━━━━━━━━━\nAuto-Backup: <b>${newStatus ? "✅ ON (Every 5m)" : "🛑 OFF"}</b>\n\nSelect a backup option below:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getBackupKeyboard(newStatus, chatId),
      },
    );
    return;
  }

  // Toggle Heartbeat (10s notification)
  if (data === "toggle_heartbeat") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access backup functions.",
        show_alert: true,
      });
      return;
    }
    if (heartbeatSubscribers.has(chatId)) {
      heartbeatSubscribers.delete(chatId);
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "10s Notifications OFF",
      });
    } else {
      heartbeatSubscribers.add(chatId);
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "10s Notifications ON",
      });
      // If auto-backup is already running, make sure heartbeat is started
      if (autoBackupInterval) startHeartbeat();
    }

    const isAuto = autoBackupInterval !== null;
    bot.editMessageText(
      `🗄️ <b>Backup Manager</b>\n━━━━━━━━━━━━━━━━━━\nAuto-Backup: <b>${isAuto ? "✅ ON (Every 5m)" : "🛑 OFF"}</b>\n10s Notification: <b>${heartbeatSubscribers.has(chatId) ? "🔔 ON" : "🔕 OFF"}</b>\n\nSelect a backup option below:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getBackupKeyboard(isAuto, chatId),
      },
    );
    return;
  }

  // Delete Domain Menu
  if (data === "delete_domain_menu") {
    bot.editMessageText(
      `➖ <b>Delete Domain</b>\n━━━━━━━━━━━━━━━━━━\nSelect a domain to remove:\n(⚠️ This cannot be undone!)`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getDeleteDomainKeyboard(chatId),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Process Delete Domain
  if (data.startsWith("delete_domain_")) {
    const index = parseInt(data.split("_")[2]);
    const domains = loadDomains(chatId);
    const domainName = domains[index] ? domains[index].name : "Unknown";

    if (deleteDomain(chatId, index)) {
      bot.editMessageText(
        `✅ <b>Domain Deleted</b>\n\nRemoved: <b>${domainName}</b>\n\nSelect an option below:`,
        {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: "HTML",
          reply_markup: getDomainKeyboard(chatId),
        },
      );
      bot.answerCallbackQuery(callbackQuery.id, { text: "Domain deleted" });
    } else {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "Error deleting domain",
      });
    }
    return;
  }

  // Clone Management Menu
  if (data === "clone_management_menu") {
    bot.editMessageText(
      `📎 <b>Clone Management</b>
━━━━━━━━━━━━━━━━━━
Manage domains that share the same database (clones).

<i>⭐ Primary domains are counted in totals
📎 Clones are NOT counted (same database)</i>

Select a clone group to manage:`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: getCloneManagementKeyboard(chatId),
      },
    );
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // View Specific Clone Group
  if (data.startsWith("view_clone_group:")) {
    const groupId = data.split(":")[1];
    const { groups } = getDomainsByCloneGroup(chatId);
    const group = groups[groupId];
    
    if (!group) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Group not found",
        show_alert: true,
      });
      return;
    }
    
    let message = `📎 <b>Clone Group</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Show primary domain
    if (group.primary) {
      message += `⭐ <b>PRIMARY (Counted)</b>\n`;
      message += `🔗 ${group.primary.name}\n`;
      message += `🌐 <code>${group.primary.url}</code>\n\n`;
    }
    
    // Show clones
    if (group.clones.length > 0) {
      message += `📎 <b>CLONES (Not Counted)</b>\n`;
      group.clones.forEach((clone) => {
        message += `🔗 ${clone.name}\n`;
        message += `🌐 <code>${clone.url}</code>\n`;
      });
    }
    
    // Build buttons for setting primary
    const buttons = [];
    group.all.forEach((domain) => {
      const isPrimary = domain.is_primary;
      const label = isPrimary 
        ? `✅ ${domain.name} (Current Primary)` 
        : `⭐ Set ${domain.name} as Primary`;
      buttons.push([{
        text: label,
        callback_data: `set_primary:${domain.index}`,
      }]);
    });
    
    buttons.push([{
      text: "⬅️ Back to Clone Management",
      callback_data: "clone_management_menu",
    }]);
    
    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // Set Domain as Primary
  if (data.startsWith("set_primary:")) {
    const domainIndex = parseInt(data.split(":")[1]);
    const domains = loadDomains(chatId);
    const domain = domains[domainIndex];
    
    if (!domain) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Domain not found",
        show_alert: true,
      });
      return;
    }
    
    // Set as primary
    const success = setDomainAsPrimary(chatId, domainIndex);
    
    if (success) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ ${domain.name} is now the primary domain for this group`,
        show_alert: true,
      });
      
      // Refresh the group view
      if (domain.clone_group_id) {
        bot.editMessageText(
          `✅ <b>Primary Domain Updated!</b>\n\n${domain.name} is now set as the primary domain.\n\n<i>This domain's balance will be counted in totals.</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{
                  text: "⬅️ Back to Group",
                  callback_data: `view_clone_group:${domain.clone_group_id}`,
                }],
              ],
            },
          },
        );
      }
    } else {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Failed to update",
        show_alert: true,
      });
    }
    return;
  }

  // View All Domains (for clone management)
  if (data === "view_all_domains_clone") {
    const domains = loadDomains(chatId);
    const { groups } = getDomainsByCloneGroup(chatId);
    
    let message = `📋 <b>All Domains</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
    
    domains.forEach((domain, index) => {
      let indicator = "";
      if (domain.clone_group_id) {
        indicator = domain.is_primary ? " ⭐" : " 📎";
      }
      message += `${index + 1}. ${domain.name}${indicator}\n`;
      message += `   <code>${domain.url}</code>\n\n`;
    });
    
    message += `<i>⭐ = Primary | 📎 = Clone</i>`;
    
    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{
            text: "⬅️ Back to Clone Management",
            callback_data: "clone_management_menu",
          }],
        ],
      },
    });
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }

  // 2. CHECK ALL MARKETS/DOMAINS
  // [MODIFIED] Now respects clone groups - only counts primary domains
  if (data === "check_all") {
    bot.answerCallbackQuery(callbackQuery.id);
    const domains = loadDomains(chatId);
    
    // Get clone group info for display
    const { groups, ungrouped } = getDomainsByCloneGroup(chatId);
    const groupCount = Object.keys(groups).length;
    const cloneIndicator = groupCount > 0 ? ` (${groupCount} clone groups detected)` : "";
    
    const loadingMsg = await bot.editMessageText(
      `⏳ <b>Checking All Markets...</b>${cloneIndicator}\n<i>Progress: [░░░░░░░░░░] 0% (0/${domains.length})</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    let completedCount = 0;
    const totalDomains = domains.length;
    let lastUpdateTime = 0;

    const updateProgress = () => {
      completedCount++;
      const now = Date.now();

      // Throttle updates: Max once per 1.5 seconds to avoid rate limits
      if (now - lastUpdateTime < 1500 && completedCount < totalDomains) {
        return;
      }
      lastUpdateTime = now;

      const percent = Math.round((completedCount / totalDomains) * 100);
      const progress = Math.floor(percent / 10);
      const bar = "█".repeat(progress) + "░".repeat(10 - progress);

      // Don't await the UI update to keep processing fast
      bot
        .editMessageText(
          `⏳ <b>Checking All Markets...</b>${cloneIndicator}\n<i>Progress: [${bar}] ${percent}% (${completedCount}/${totalDomains})</i>`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
          },
        )
        .catch(() => {}); // Ignore errors
    };

    const promises = domains.map(async (domain) => {
      const api = getApi(domain.url);

      const fetchWithRetry = async (endpoint, retries = 1) => {
        for (let i = 0; i <= retries; i++) {
          try {
            return await api.get(endpoint);
          } catch (err) {
            if (i === retries) throw err;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      };

      try {
        const requests = [fetchWithRetry("/system-info")];
        if (domain.has_merchant) {
          requests.push(fetchWithRetry("/merchant"));
        }

        const results = await Promise.allSettled(requests);
        updateProgress(); // Update progress without blocking
        return {
          domain: domain,
          sysRes: results[0],
          merchRes: domain.has_merchant ? results[1] : null,
        };
      } catch (err) {
        await updateProgress(); // Update progress even on error
        return {
          domain: domain,
          error: err.message,
        };
      }
    });

    const results = await Promise.all(promises);

    // Process results
    // [MODIFIED] Track which clone groups have been counted (with failover)
    const countedGroups = new Set();
    const failedPrimaries = new Set(); // Track failed primary domains
    let totalAdmin = 0;
    let totalMerchant = 0;
    let totalMerchantAvailable = 0;
    let domainLines = [];

    // First pass: Check all domains and identify failed primaries
    for (const res of results) {
      const { domain } = res;
      
      if (domain.clone_group_id && domain.is_primary && (res.error || 
          (res.sysRes?.status !== "fulfilled" || !res.sysRes?.value?.data?.success))) {
        // Primary domain failed - mark for failover
        failedPrimaries.add(domain.clone_group_id);
      }
    }

    // Second pass: Build report with failover logic
    for (const res of results) {
      const { domain } = res;
      
      // Skip clones that won't be counted (only show primary or failover clones)
      if (domain.clone_group_id && !domain.is_primary) {
        // Check if this clone will be used as failover
        const willBeFailover = failedPrimaries.has(domain.clone_group_id) && 
                               !countedGroups.has(domain.clone_group_id) &&
                               !res.error &&
                               res.sysRes?.status === "fulfilled" && 
                               res.sysRes?.value?.data?.success;
        
        if (!willBeFailover) {
          // This is a clone that won't be counted - skip displaying it
          continue;
        }
      }
      
      const safeName = escapeHtml(domain.name);
      const safeUrl = escapeHtml(domain.url);
      
      // Build clone indicator
      let cloneIndicator = "";
      let isFailover = false;
      if (domain.clone_group_id) {
        if (domain.is_primary) {
          cloneIndicator = " ⭐"; // Primary domain indicator
        } else if (failedPrimaries.has(domain.clone_group_id) && 
                   !countedGroups.has(domain.clone_group_id) &&
                   !res.error &&
                   res.sysRes?.status === "fulfilled" && 
                   res.sysRes?.value?.data?.success) {
          // This is a clone that will be counted as failover
          cloneIndicator = " 📎🔄"; // Clone acting as failover
          isFailover = true;
        }
      }

      if (res.error) {
        const safeError = escapeHtml(res.error);
        domainLines.push(
          `🔗 <b>${safeName}${cloneIndicator}</b>\n🌐 <code>${safeUrl}</code>\n❌ <b>DOWN: Connection Failed: ${safeError}</b>\n──────────────────\n`,
        );
        continue;
      }

      const { sysRes, merchRes } = res;
      let adminVal = 0;

      // System Stats
      if (sysRes.status === "fulfilled" && sysRes.value.data.success) {
        const s = sysRes.value.data.data;
        const statusCode = sysRes.value.status;
        adminVal =
          parseFloat(String(s.admin_balance).replace(/[^\d.-]/g, "")) || 0;
        
        // [MODIFIED] Count logic with failover support
        let shouldCount = true;
        let countNote = "";
        
        if (domain.clone_group_id) {
          if (countedGroups.has(domain.clone_group_id)) {
            // Group already counted (either primary or another clone)
            shouldCount = false;
          } else if (domain.is_primary) {
            // This is primary and group not counted yet - count it
            countedGroups.add(domain.clone_group_id);
            countNote = "";
          } else if (isFailover) {
            // Primary failed, this clone is available - count as failover
            countedGroups.add(domain.clone_group_id);
            countNote = " (failover - primary down)";
          } else {
            // This is a clone but either primary succeeded or another clone was counted
            shouldCount = false;
          }
        }
        
        if (shouldCount) {
          totalAdmin += adminVal;
        }

        // Simple Domain Line: Status + Balance (with clone indicator)
        const safeBalance = escapeHtml(s.admin_balance);
        const balanceNote = countNote; // Only show failover note if applicable
        domainLines.push(
          `🔗 <b>${safeName}${cloneIndicator}</b>\n🌐 <code>${safeUrl}</code>\n✅ <b>ALIVE (${statusCode})</b>\n💰 Balance: ₱${safeBalance}${balanceNote}\n──────────────────\n`,
        );
      } else {
        let errorMsg = "Unknown Error";
        if (sysRes.status === "rejected") {
          const error = sysRes.reason;
          if (error.response) {
            errorMsg = `Status ${error.response.status}: ${error.response.statusText || "Down"}`;
          } else if (error.request) {
            errorMsg = "No Response (Timeout/Down)";
          } else {
            errorMsg = error.message;
          }
        } else if (sysRes.value && !sysRes.value.data.success) {
          errorMsg = sysRes.value.data.error || "API Error";
        }

        const safeErrorMsg = escapeHtml(errorMsg);
        domainLines.push(
          `🔗 <b>${safeName}${cloneIndicator}</b>\n🌐 <code>${safeUrl}</code>\n❌ <b>DOWN: ${safeErrorMsg}</b>\n──────────────────\n`,
        );
      }

      // Merchant Stats
      if (domain.has_merchant && merchRes) {
        if (merchRes.status === "fulfilled" && merchRes.value.data.success) {
          const m = merchRes.value.data.data.merchant_balance;
          const mAmt = m.amount;
          const mAvail = m.availableAmount || m.amount;

          totalMerchant +=
            parseFloat(String(mAmt).replace(/[^\d.-]/g, "")) || 0;
          totalMerchantAvailable +=
            parseFloat(String(mAvail).replace(/[^\d.-]/g, "")) || 0;
        }
      }
    }

    // Construct Final Message
    const totalAdminFormatted = totalAdmin.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    
    // Count how many domains were actually counted (including failovers)
    const countedDomains = results.filter(r => {
      if (r.error) return false;
      const domain = r.domain;
      if (!domain.clone_group_id) return true;
      // Count if primary OR if it's a failover clone
      if (domain.is_primary) return true;
      // Check if this clone was counted as failover
      const groupId = domain.clone_group_id;
      const primaryFailed = failedPrimaries.has(groupId);
      const wasCounted = countedGroups.has(groupId);
      return primaryFailed && wasCounted && 
             r.sysRes?.status === "fulfilled" && 
             r.sysRes?.value?.data?.success;
    }).length;

    const failoverCount = failedPrimaries.size;
    const failoverNote = failoverCount > 0 ? `\n<i>⚠️ ${failoverCount} failover(s) used</i>` : "";

    let finalMessage = `
📊 <b>ALL MARKETS REPORT</b>
🕒 ${formatTime()}
━━━━━━━━━━━━━━━━━━
💰 <b>TOTAL BALANCE: ₱${totalAdminFormatted}</b>
<i>(${countedDomains} unique domains counted)</i>${failoverNote}
━━━━━━━━━━━━━━━━━━
<b>List of Domains:</b>
<i>⭐ = Primary | 📎🔄 = Failover (primary down)</i>
`;

    finalMessage += domainLines.join("");

    finalMessage += `━━━━━━━━━━━━━━━━━━
💰 <b>TOTAL BALANCE: ₱${totalAdminFormatted}</b>
`;

    bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      reply_markup: getBackKeyboard(),
    });

    return;
  }

  // 3. BACKUP ALL
  if (data === "backup_all") {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access backup functions.",
        show_alert: true,
      });
      return;
    }
    bot.answerCallbackQuery(callbackQuery.id);
    const domains = loadDomains(chatId);
    bot.editMessageText(
      `⏳ <b>Starting Full Backup...</b>\n<i>Creating backups for ${domains.length} databases...</i>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: "HTML",
      },
    );

    let successCount = 0;
    let failCount = 0;
    let summary = "<b>Backup Summary:</b>\n";

    for (const domain of domains) {
      try {
        await bot.sendMessage(
          chatId,
          `⏳ Backing up <b>${domain.name}</b>...`,
          { parse_mode: "HTML" },
        );
        const api = getApi(domain.url);
        const response = await api.post("/create-backup", {
          api_name: "bot_manual_all",
        });

        if (response.data.success) {
          const { filename, sql_content, original_size, database_name } =
            response.data.data;

          // Create Subfolder
          const domainBackupDir = path.join(BACKUP_DIR, domain.name);
          if (!fs.existsSync(domainBackupDir)) {
            fs.mkdirSync(domainBackupDir, { recursive: true });
          }

          const filePath = path.join(domainBackupDir, filename);
          fs.writeFileSync(filePath, sql_content);

          // --- NEW: Encrypt the backup immediately ---
          const encPath = filePath + ".enc";
          encryptFile(filePath, encPath, secret);
          fs.unlinkSync(filePath); // Delete plain SQL
          // ------------------------------------------

          // Upload to MEGA
          try {
            await megaService.uploadBackup(encPath, domain.name);
          } catch (megaErr) {
            console.error(
              `[BACKUP_ALL_MEGA_ERROR] ${domain.name}:`,
              megaErr.message,
            );
            await bot.sendMessage(
              chatId,
              `⚠️ <b>${domain.name}</b>: Backup created but MEGA upload failed.`,
              { parse_mode: "HTML" },
            );
          }

          // Run cleanup
          cleanupBackups(domain.name);

          successCount++;
          summary += `✅ ${domain.name}: Success\n`;
        } else {
          failCount++;
          summary += `❌ ${domain.name}: Failed (${response.data.error})\n`;
        }
      } catch (err) {
        failCount++;
        summary += `❌ ${domain.name}: Error (${err.message})\n`;
      }
    }

    await bot.sendMessage(
      chatId,
      `🏁 <b>Full Backup Complete</b>\n✅ Success: ${successCount}\n❌ Failed: ${failCount}\n\n${summary}`,
      {
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      },
    );

    return;
  }

  // 4. Individual Backup Action
  if (data.startsWith("backup_")) {
    // Restrict access to only developer ChatID
    if (chatId !== parseInt(process.env.DEVELOPER_CHAT_ID)) {
      bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Access Denied: Only the developer can access backup functions.",
        show_alert: true,
      });
      return;
    }
    bot.answerCallbackQuery(callbackQuery.id, { text: "Backup started..." });
    const index = parseInt(data.split("_")[1]);
    const domains = loadDomains(chatId);
    const domain = domains[index];

    if (!domain) return;

    bot.sendMessage(
      chatId,
      `⏳ <b>Starting Backup for ${domain.name}...</b>\nPlease wait, downloading file...`,
      { parse_mode: "HTML" },
    );

    try {
      const api = getApi(domain.url);
      const response = await api.post("/create-backup", {
        api_name: "bot_manual",
      });

      if (response.data.success) {
        const { filename, sql_content, original_size, database_name } =
          response.data.data;

        // Create Subfolder
        const domainBackupDir = path.join(BACKUP_DIR, domain.name);
        if (!fs.existsSync(domainBackupDir)) {
          fs.mkdirSync(domainBackupDir, { recursive: true });
        }

        const filePath = path.join(domainBackupDir, filename);

        fs.writeFileSync(filePath, sql_content);

        // --- NEW: Encrypt the backup immediately ---
        const encPath = filePath + ".enc";
        encryptFile(filePath, encPath, secret);
        fs.unlinkSync(filePath); // Delete plain SQL
        // ------------------------------------------

        // Upload to MEGA
        try {
          await megaService.uploadBackup(encPath, domain.name);
          await bot.sendMessage(chatId, `☁️ <b>MEGA Upload Success!</b>`, {
            parse_mode: "HTML",
          });
        } catch (megaErr) {
          console.error(
            `[BACKUP_SINGLE_MEGA_ERROR] ${domain.name}:`,
            megaErr.message,
          );
          await bot.sendMessage(
            chatId,
            `⚠️ <b>MEGA Upload Failed:</b> ${megaErr.message}`,
            { parse_mode: "HTML" },
          );
        }

        // Run cleanup
        cleanupBackups(domain.name);

        await bot.sendMessage(
          chatId,
          `✅ <b>Backup Complete!</b>\n🗄 DB: ${database_name}\n💾 Size: ${original_size}`,
          { parse_mode: "HTML" },
        );
      } else {
        bot.sendMessage(chatId, `❌ Backup Failed: ${response.data.error}`);
      }
    } catch (error) {
      bot.sendMessage(chatId, `❌ Backup Request Failed: ${error.message}`);
    }
  }
});

// Fetch and log bot username
bot.getMe().then((botInfo) => {
  console.log(`🤖 Bot Username: @${botInfo.username}`);
  console.log(`🤖 Bot Name: ${botInfo.first_name}`);
});

console.log("🤖 System Info Bot is running...");
console.log(`📂 Data is stored in: ${USERS_DIR}`);

// ==================== KEEP-ALIVE FOR RENDER FREE TIER ====================
const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// Self-ping every 14 minutes to prevent Render free tier spin-down
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    https.get(`${RENDER_URL}/health`, (res) => {
      console.log(`♻️ Keep-alive ping: ${res.statusCode}`);
    }).on("error", (err) => {
      console.error("Keep-alive ping failed:", err.message);
    });
  }, 14 * 60 * 1000); // 14 minutes
}
