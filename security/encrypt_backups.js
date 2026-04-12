const fs = require('fs');
const path = require('path');
const { encryptFile } = require('./security');

const password = process.env.BOT_SECRET || process.argv[2];

if (!password) {
    console.error('❌ Error: BOT_SECRET not found in environment and no password provided.');
    process.exit(1);
}

const backupsDir = path.join(__dirname, '..', 'backups');

function scanAndEncrypt(dir) {
    const items = fs.readdirSync(dir);
    
    items.forEach(item => {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            scanAndEncrypt(fullPath);
        } else if (item.endsWith('.sql')) {
            const outputPath = fullPath + '.enc';
            console.log(`🔒 Encrypting: ${item}...`);
            try {
                encryptFile(fullPath, outputPath, password);
                fs.unlinkSync(fullPath); // Delete original
                console.log(`✅ Secured: ${item}`);
            } catch (err) {
                console.error(`❌ Failed to encrypt ${item}:`, err.message);
            }
        }
    });
}

console.log('--------------------------------------------------');
console.log('🚀 Starting Backup Encryption...');
console.log('--------------------------------------------------');

if (fs.existsSync(backupsDir)) {
    scanAndEncrypt(backupsDir);
    console.log('--------------------------------------------------');
    console.log('✅ ALL BACKUPS SECURED.');
    console.log('--------------------------------------------------');
} else {
    console.error('❌ backups directory not found.');
}
