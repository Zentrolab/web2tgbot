const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypts a string using a password
 */
function encrypt(text, password) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = crypto.scryptSync(password, 'salt', 32);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts a string using a password
 */
function decrypt(text, password) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = crypto.scryptSync(password, 'salt', 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

/**
 * Loads encrypted environment variables into process.env
 */
function loadEncryptedEnv(password) {
    const encPath = path.join(__dirname, '..', '.env.enc');
    const plainPath = path.join(__dirname, '..', '.env');

    // If encrypted file exists, use it
    if (fs.existsSync(encPath)) {
        try {
            const encryptedData = fs.readFileSync(encPath, 'utf8');
            const decryptedData = decrypt(encryptedData, password);
            
            // Parse decrypted data (like dotenv does)
            const lines = decryptedData.split('\n');
            lines.forEach(line => {
                const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
                if (match) {
                    const key = match[1];
                    let value = match[2] || '';
                    // Remove quotes if present
                    if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
                        value = value.replace(/^"|"$/g, '');
                    }
                    process.env[key] = value;
                }
            });
            console.log('✅ Encrypted .env loaded successfully.');
            return true;
        } catch (err) {
            console.error('❌ Failed to decrypt .env.enc. Check your password.');
            return false;
        }
    } 
    
    // Fallback to plain .env for development if encrypted doesn't exist
    if (fs.existsSync(plainPath)) {
        require('dotenv').config();
        console.log('⚠️ Using plain .env file (Development Mode).');
        return true;
    }

    console.error('❌ No .env or .env.enc file found.');
    return false;
}

/**
 * Encrypts a file on disk
 */
function encryptFile(inputPath, outputPath, password) {
    const text = fs.readFileSync(inputPath, 'utf8');
    const encrypted = encrypt(text, password);
    fs.writeFileSync(outputPath, encrypted);
}

/**
 * Decrypts a file on disk
 */
function decryptFile(inputPath, outputPath, password) {
    const encrypted = fs.readFileSync(inputPath, 'utf8');
    const decrypted = decrypt(encrypted, password);
    fs.writeFileSync(outputPath, decrypted);
}

module.exports = { encrypt, decrypt, loadEncryptedEnv, encryptFile, decryptFile };
