const { File, Storage } = require('megajs');
const fs = require('fs');
const path = require('path');

/**
 * MEGA Service to manage cloud templates
 */
class MegaService {
    constructor() {
        this.folderUrl = process.env.MEGA_FOLDER_URL;
        this.email = process.env.MEGA_EMAIL;
        this.password = process.env.MEGA_PASSWORD;
    }

    /**
     * Authenticate and return a storage object
     */
    async _getAuthenticatedStorage() {
        if (!this.email || !this.password) {
            throw new Error('MEGA_EMAIL or MEGA_PASSWORD is not defined in .env');
        }

        return new Promise((resolve, reject) => {
            const storage = new Storage({
                email: this.email,
                password: this.password,
                autologin: true
            });

            storage.on('ready', () => {
                resolve(storage);
            });

            storage.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Load folder attributes with timeout and retry
     */
    async _loadFolderWithRetry(url, retries = 2, timeoutMs = 15000) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const folder = File.fromURL(url);
                await Promise.race([
                    folder.loadAttributes(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('MEGA loadAttributes timed out')), timeoutMs)
                    )
                ]);
                return folder;
            } catch (err) {
                const isLastAttempt = attempt === retries;
                // Catch the cryptic megajs decryption error
                if (err.message && err.message.includes("Cannot read properties of undefined")) {
                    if (isLastAttempt) {
                        throw new Error(
                            'MEGA folder decryption failed. This usually means the folder link or key is invalid/expired. ' +
                            'Please verify MEGA_FOLDER_URL in your .env is correct and the folder still exists.'
                        );
                    }
                    console.warn(`[MEGA] Attempt ${attempt + 1} failed (decryption error), retrying...`);
                    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                    continue;
                }
                if (isLastAttempt) throw err;
                console.warn(`[MEGA] Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    /**
     * List all .zip files in the configured MEGA folder
     */
    async listTemplates() {
        if (!this.folderUrl) {
            throw new Error('MEGA_FOLDER_URL is not defined in .env');
        }

        try {
            // Re-read from env to ensure we have the latest if it changed
            let url = process.env.MEGA_FOLDER_URL;
            
            // Strip surrounding quotes if present (common .env misconfiguration)
            if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
                url = url.slice(1, -1);
            }

            if (!url.includes('#')) {
                throw new Error('MEGA_FOLDER_URL is missing the decryption key (the part after #). Please wrap the URL in double quotes in your .env file.');
            }

            const folder = await this._loadFolderWithRetry(url);
            
            if (!folder.children) {
                throw new Error('The provided MEGA link is not a folder or has no accessible files.');
            }

            // Filter for .zip files
            const files = folder.children
                .filter(file => !file.directory && file.name.toLowerCase().endsWith('.zip'))
                .map(file => ({
                    name: file.name,
                    size: file.size,
                    handle: file.handle
                }));

            return files;
        } catch (error) {
            console.error('Error listing MEGA templates:', error);
            throw error;
        }
    }

    /**
     * Download a specific file from MEGA to a local path
     * @param {string} fileName Name of the file to download
     * @param {string} targetPath Local path to save the file
     */
    async downloadTemplate(fileName, targetPath) {
        if (!this.folderUrl) {
            throw new Error('MEGA_FOLDER_URL is not defined in .env');
        }

        try {
            let url = process.env.MEGA_FOLDER_URL;
            // Strip surrounding quotes if present
            if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
                url = url.slice(1, -1);
            }
            if (!url.includes('#')) {
                throw new Error('MEGA_FOLDER_URL is missing the decryption key (the part after #).');
            }

            const folder = await this._loadFolderWithRetry(url);

            if (!folder.children) {
                throw new Error('The provided MEGA link is not a folder.');
            }

            const file = folder.children.find(f => f.name === fileName);
            if (!file) {
                throw new Error(`File ${fileName} not found in MEGA folder`);
            }

            return new Promise((resolve, reject) => {
                const downloadStream = file.download();
                const writeStream = fs.createWriteStream(targetPath);

                downloadStream.pipe(writeStream);

                writeStream.on('finish', () => {
                    resolve(targetPath);
                });

                writeStream.on('error', (err) => {
                    reject(err);
                });

                downloadStream.on('error', (err) => {
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`Error downloading ${fileName} from MEGA:`, error);
            throw error;
        }
    }

    /**
     * Upload a backup file to a 'backups' folder in the MEGA account
     * @param {string} localFilePath Path to the local file to upload
     * @param {string} domainName The domain name (used for subfolder)
     */
    async uploadBackup(localFilePath, domainName) {
        try {
            const storage = await this._getAuthenticatedStorage();
            
            // Find or create 'backups' folder in root
            let backupsFolder = storage.root.children.find(f => f.name === 'backups' && f.directory);
            if (!backupsFolder) {
                backupsFolder = await storage.root.mkdir('backups');
            }

            // Find or create domain subfolder
            let domainFolder = backupsFolder.children.find(f => f.name === domainName && f.directory);
            if (!domainFolder) {
                domainFolder = await backupsFolder.mkdir(domainName);
            }

            const fileName = path.basename(localFilePath);
            const fileStats = fs.statSync(localFilePath);

            return new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(localFilePath);
                const uploadStream = domainFolder.upload({
                    name: fileName,
                    size: fileStats.size
                }, (err, file) => {
                    if (err) return reject(err);
                    resolve(file);
                });

                readStream.pipe(uploadStream);
                
                uploadStream.on('error', (err) => {
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`Error uploading backup ${localFilePath} to MEGA:`, error);
            throw error;
        }
    }
}

module.exports = new MegaService();
