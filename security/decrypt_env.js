const fs = require('fs');
const path = require('path');
const { decrypt } = require('./security');

// Usage: node decrypt_env.js YOUR_PASSWORD
const password = process.argv[2];

if (!password) {
    console.error('❌ Error: Please provide a password.');
    console.log('Usage: node decrypt_env.js YOUR_SECRET_PASSWORD');
    process.exit(1);
}

const encPath = path.join(__dirname, '..', '.env.enc');
const plainPath = path.join(__dirname, '..', '.env');

if (!fs.existsSync(encPath)) {
    console.error('❌ Error: .env.enc file not found.');
    process.exit(1);
}

try {
    const encryptedData = fs.readFileSync(encPath, 'utf8');
    const decryptedData = decrypt(encryptedData, password);
    
    fs.writeFileSync(plainPath, decryptedData);
    
    console.log('--------------------------------------------------');
    console.log('✅ SUCCESS: .env.enc has been decrypted to .env');
    console.log('--------------------------------------------------');
    console.log('👉 ACTION REQUIRED:');
    console.log('1. You can now edit your .env file.');
    console.log('2. After editing, run: node encrypt_env.js YOUR_PASSWORD');
    console.log('3. Remember to delete .env again after re-encrypting!');
    console.log('--------------------------------------------------');

} catch (err) {
    console.error('❌ Decryption failed: Invalid password or corrupted file.');
}
