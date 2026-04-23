const { API, File, Storage } = require('megajs');
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
        this.requestTimeoutMs = this._getRequestTimeoutMs();
    }

    _getRequestTimeoutMs() {
        const configuredTimeout = Number(process.env.MEGA_REQUEST_TIMEOUT_MS || 45000);
        return Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 45000;
    }

    _normalizeFolderUrl() {
        const configuredUrl = process.env.MEGA_FOLDER_URL || this.folderUrl;

        if (!configuredUrl) {
            throw new Error('MEGA_FOLDER_URL is not defined in .env');
        }

        let normalizedUrl = configuredUrl.trim();

        if ((normalizedUrl.startsWith('"') && normalizedUrl.endsWith('"')) || (normalizedUrl.startsWith("'") && normalizedUrl.endsWith("'"))) {
            normalizedUrl = normalizedUrl.slice(1, -1);
        }

        if (!normalizedUrl.includes('#')) {
            throw new Error('MEGA_FOLDER_URL is missing the decryption key (the part after #). Please verify the full folder URL is set.');
        }

        return normalizedUrl;
    }

    async _megaFetch(url, options = {}) {
        const timeoutMs = this._getRequestTimeoutMs();
        const timeoutController = new AbortController();
        const upstreamSignal = options.signal;

        const relayAbort = () => {
            if (!timeoutController.signal.aborted) {
                timeoutController.abort(upstreamSignal?.reason || new Error('MEGA request aborted'));
            }
        };

        const timeoutId = setTimeout(() => {
            if (!timeoutController.signal.aborted) {
                timeoutController.abort(new Error(`MEGA request timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        if (upstreamSignal) {
            if (upstreamSignal.aborted) {
                relayAbort();
            } else {
                upstreamSignal.addEventListener('abort', relayAbort, { once: true });
            }
        }

        try {
            return await fetch(url, {
                ...options,
                signal: timeoutController.signal,
            });
        } catch (error) {
            if (timeoutController.signal.aborted && !(upstreamSignal && upstreamSignal.aborted)) {
                throw new Error(`MEGA request timed out after ${timeoutMs}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            if (upstreamSignal) {
                upstreamSignal.removeEventListener('abort', relayAbort);
            }
        }
    }

    _createApi() {
        return new API(false, {
            fetch: this._megaFetch.bind(this),
            userAgent: 'telegrambot',
        });
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
                autologin: true,
                keepalive: false,
                fetch: this._megaFetch.bind(this),
                userAgent: 'telegrambot',
            });

            const timeoutMs = this._getRequestTimeoutMs();
            const timeoutId = setTimeout(() => {
                storage.close().catch(() => {});
                reject(new Error(`MEGA authentication timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const cleanup = () => clearTimeout(timeoutId);

            storage.on('ready', () => {
                cleanup();
                resolve(storage);
            });

            storage.on('error', (err) => {
                cleanup();
                reject(err);
            });
        });
    }

    /**
     * Load folder attributes with timeout and retry
     */
    async _loadFolderWithRetry(url, retries = 2, timeoutMs = this._getRequestTimeoutMs()) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            const api = this._createApi();
            try {
                const folder = File.fromURL(url, { api });
                await Promise.race([
                    folder.loadAttributes(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('MEGA loadAttributes timed out')), timeoutMs)
                    )
                ]);
                return { folder, api };
            } catch (err) {
                api.close();
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
            const url = this._normalizeFolderUrl();
            const { folder, api } = await this._loadFolderWithRetry(url);

            try {
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
            } finally {
                api.close();
            }
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
            const url = this._normalizeFolderUrl();
            const { folder, api } = await this._loadFolderWithRetry(url);

            try {
                if (!folder.children) {
                    throw new Error('The provided MEGA link is not a folder.');
                }

                const file = folder.children.find(f => f.name === fileName);
                if (!file) {
                    throw new Error(`File ${fileName} not found in MEGA folder`);
                }

                return await new Promise((resolve, reject) => {
                    const downloadStream = file.download();
                    const writeStream = fs.createWriteStream(targetPath);
                    const timeoutMs = this._getRequestTimeoutMs();
                    let finished = false;
                    let timeoutId = null;

                    const cleanup = () => {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                        }
                    };

                    const resetTimeout = () => {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                        }
                        timeoutId = setTimeout(() => {
                            if (finished) {
                                return;
                            }
                            finished = true;
                            downloadStream.destroy(new Error(`MEGA download timed out after ${timeoutMs}ms`));
                            writeStream.destroy(new Error(`MEGA download timed out after ${timeoutMs}ms`));
                            reject(new Error(`MEGA download timed out after ${timeoutMs}ms`));
                        }, timeoutMs);
                    };

                    downloadStream.pipe(writeStream);
                    resetTimeout();

                    downloadStream.on('data', () => {
                        resetTimeout();
                    });

                    writeStream.on('finish', () => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        cleanup();
                        resolve(targetPath);
                    });

                    writeStream.on('error', (err) => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        cleanup();
                        reject(err);
                    });

                    downloadStream.on('error', (err) => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        cleanup();
                        reject(err);
                    });
                });
            } finally {
                api.close();
            }
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
