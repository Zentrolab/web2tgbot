const fs = require('fs');
const path = require('path');
const { encrypt } = require('./security');

// Usage: node encrypt_env.js YOUR_PASSWORD
const password = process.argv[2];

if (!password) {
    console.error('❌ Error: Please provide a password.');
    console.log('Usage: node encrypt_env.js YOUR_SECRET_PASSWORD');
    process.exit(1);
}

const plainPath = path.join(__dirname, '..', '.env');
const encPath = path.join(__dirname, '..', '.env.enc');

if (!fs.existsSync(plainPath)) {
    console.error('❌ Error: .env file not found.');
    process.exit(1);
}

try {
    const plainData = fs.readFileSync(plainPath, 'utf8');
    const encryptedData = encrypt(plainData, password);
    
    fs.writeFileSync(encPath, encryptedData);
    
    console.log('--------------------------------------------------');
    console.log('✅ SUCCESS: .env has been encrypted to .env.enc');
    console.log('--------------------------------------------------');
    console.log('👉 ACTION REQUIRED:');
    console.log('1. Delete your plain .env file now.');
    console.log('2. Set your password in your OS environment variables:');
    console.log('   Windows: setx BOT_SECRET "' + password + '"');
    console.log('   Linux: export BOT_SECRET="' + password + '"');
    console.log('--------------------------------------------------');

} catch (err) {
    console.error('❌ Encryption failed:', err.message);
}
