const fs = require('fs');
const path = require('path');

const USERS_DIR = path.join(__dirname, 'users');

// Helper: Get user bundler settings file path
const getUserBundlerSettingsFile = (chatId) => {
    const userFolder = path.join(USERS_DIR, String(chatId));
    if (!fs.existsSync(userFolder)) {
        fs.mkdirSync(userFolder, { recursive: true });
    }
    return path.join(userFolder, 'bundlerSettings.json');
};

// Load Bundler Settings
const loadBundlerSettings = (chatId) => {
    try {
        const settingsFile = getUserBundlerSettingsFile(chatId);
        if (fs.existsSync(settingsFile)) {
            return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        }
    } catch (err) {
        console.error(`Error reading bundlerSettings.json for user ${chatId}:`, err);
    }
    // Default Settings
    return {
        snipers: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, amount: 0.001 })),
        buyAmount: 0.01,
        devAmount: 0.0112,
        tipAmount: 0.023,
        slippage: 10,
        devWalletKey: null
    };
};

// Save Bundler Settings
const saveBundlerSettings = (chatId, settings) => {
    fs.writeFileSync(getUserBundlerSettingsFile(chatId), JSON.stringify(settings, null, 2));
};

// Generate Main Menu Keyboard
const getBundlerKeyboard = (settings) => {
    const sniperButtons = [];
    // Create grid of 2 columns
    for (let i = 0; i < settings.snipers.length; i += 2) {
        const row = [];
        const s1 = settings.snipers[i];
        row.push({ text: `✏️ Sniper #${s1.id} (${s1.amount} SOL)`, callback_data: `bundler_edit_sniper:${s1.id}` });
        
        if (i + 1 < settings.snipers.length) {
            const s2 = settings.snipers[i + 1];
            row.push({ text: `✏️ Sniper #${s2.id} (${s2.amount} SOL)`, callback_data: `bundler_edit_sniper:${s2.id}` });
        }
        sniperButtons.push(row);
    }

    return {
        inline_keyboard: [
            [{ text: '🎯 Active Snipers (Click to Edit)', callback_data: 'bundler_noop' }],
            ...sniperButtons,
            [{ text: '────────────────────────', callback_data: 'bundler_noop' }],
            [
                { text: `👥 Count: ${settings.snipers.length}`, callback_data: 'bundler_set_count' },
                { text: `💰 Buy: ${settings.buyAmount} SOL`, callback_data: 'bundler_set_buy' }
            ],
            [
                { text: `🎯 Dev: ${settings.devAmount} SOL`, callback_data: 'bundler_set_dev' },
                { text: `⚡ Tip: ${settings.tipAmount} SOL`, callback_data: 'bundler_set_tip' }
            ],
            [{ text: `📊 Slip: ${settings.slippage}%`, callback_data: 'bundler_set_slip' }],
            [{ text: '🗝️ Set Dev Wallet Key', callback_data: 'bundler_set_key' }],
            [{ text: '⬅️ Back', callback_data: 'main_menu' }]
        ]
    };
};

// Handle /bundler command
const handleBundlerCommand = (bot, msg) => {
    const chatId = msg.chat.id;
    const settings = loadBundlerSettings(chatId);
    
    bot.sendMessage(chatId, `⚙️ <b>Bundler Settings</b>\n\n👇 <b>Select a sniper below to override buy amount:</b>`, {
        parse_mode: 'HTML',
        reply_markup: getBundlerKeyboard(settings)
    });
};

// Handle Callbacks
const handleCallback = async (bot, query, userStates) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === 'bundler_noop') {
        bot.answerCallbackQuery(query.id);
        return;
    }

    const settings = loadBundlerSettings(chatId);

    // Edit Sniper Menu
    if (data.startsWith('bundler_edit_sniper:')) {
        const sniperId = parseInt(data.split(':')[1]);
        const sniper = settings.snipers.find(s => s.id === sniperId);
        
        if (!sniper) {
            bot.answerCallbackQuery(query.id, { text: 'Sniper not found', show_alert: true });
            return;
        }

        bot.editMessageText(`✏️ <b>Edit Sniper #${sniperId}</b>\n\n💰 Amount: <b>${sniper.amount} SOL</b>\n🗝️ Wallet: <i>${sniper.wallet || 'Not Set'}</i>`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Edit Amount', callback_data: `bundler_set_sniper_amt:${sniperId}` }],
                    [{ text: '🗝️ Set Wallet', callback_data: `bundler_set_sniper_wallet:${sniperId}` }],
                    [{ text: '❌ Remove Sniper', callback_data: `bundler_rem_sniper:${sniperId}` }],
                    [{ text: '⬅️ Back to Bundler', callback_data: 'bundler_menu' }]
                ]
            }
        });
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Edit Sniper Amount Prompt
    if (data.startsWith('bundler_set_sniper_amt:')) {
        const sniperId = parseInt(data.split(':')[1]);
        if (userStates) {
            userStates[chatId] = { step: 'BUNDLER_AWAIT_SNIPER_AMT', sniperId: sniperId };
            bot.sendMessage(chatId, `💰 <b>Enter Amount for Sniper #${sniperId}:</b>\n\n(Current: ${settings.snipers.find(s => s.id === sniperId).amount} SOL)`, { parse_mode: 'HTML' });
        }
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Set Wallet Prompt
    if (data.startsWith('bundler_set_sniper_wallet:')) {
        const sniperId = parseInt(data.split(':')[1]);
        if (userStates) {
            userStates[chatId] = { step: 'BUNDLER_AWAIT_SNIPER_WALLET', sniperId: sniperId };
            bot.sendMessage(chatId, `🗝️ <b>Enter Wallet Key for Sniper #${sniperId}:</b>`, { parse_mode: 'HTML' });
        }
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Back to Main Bundler Menu
    if (data === 'bundler_menu') {
        bot.editMessageText(`⚙️ <b>Bundler Settings</b>\n\n👇 <b>Select a sniper below to override buy amount:</b>`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'HTML',
            reply_markup: getBundlerKeyboard(settings)
        });
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Set Count (Add/Remove Snipers)
    if (data === 'bundler_set_count') {
        const newId = settings.snipers.length + 1;
        settings.snipers.push({ id: newId, amount: 0.001 });
        saveBundlerSettings(chatId, settings);
        
        bot.editMessageReplyMarkup(getBundlerKeyboard(settings), {
            chat_id: chatId,
            message_id: msgId
        });
        bot.answerCallbackQuery(query.id, { text: `Added Sniper #${newId}` });
        return;
    }
    
    // Set Buy Amount (Global)
    if (data === 'bundler_set_buy') {
         if (userStates) {
             userStates[chatId] = { step: 'BUNDLER_AWAIT_GLOBAL_BUY' };
             bot.sendMessage(chatId, `💰 <b>Enter Global Buy Amount (SOL):</b>`, { parse_mode: 'HTML' });
         }
         bot.answerCallbackQuery(query.id);
         return;
    }

    // Default Fallback
    bot.answerCallbackQuery(query.id, { text: 'Feature coming soon!' });
};

module.exports = {
    handleBundlerCommand,
    handleCallback,
    loadBundlerSettings,
    saveBundlerSettings
};
