require('dotenv').config();
const { Client } = require('ssh2');
const axios = require('axios');

const CRON_JOB_ORG_API_KEY = process.env.CRON_JOB_ORG_API_KEY;
const CRON_JOB_ORG_BASE_URL = 'https://api.cron-job.org';

const requireEnv = (name) => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required for SSH authentication`);
    }
    return value;
};

const normalizePrivateKey = (privateKey) => {
    let normalized = privateKey.trim();

    if (
        (normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
        normalized = normalized.slice(1, -1);
    }

    normalized = normalized.replace(/\r\n/g, '\n').replace(/\\n/g, '\n');

    if (!normalized.endsWith('\n')) {
        normalized += '\n';
    }

    return normalized;
};

const getSshConfig = () => ({
    host: requireEnv('SSH_HOST'),
    port: Number(process.env.SSH_PORT || 22),
    username: requireEnv('SSH_USER'),
    privateKey: normalizePrivateKey(requireEnv('SSH_PRIVATE_KEY')),
});

const config = getSshConfig();

/**
 * Timestamped logger for debug
 */
const ts = () => {
    const now = new Date();
    return `[${now.toISOString()}]`;
};

/**
 * Execute a command on the remote server
 */
const execCommand = (command) => {
    const startTime = Date.now();
    console.log(`${ts()} [EXEC] ──────────────────────────────────────`);
    console.log(`${ts()} [EXEC] Command: ${command}`);
    console.log(`${ts()} [EXEC] SSH Config: host=${config.host}, port=${config.port}, user=${config.username}, auth=privateKey`);

    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            console.log(`${ts()} [EXEC] SSH connection READY (took ${Date.now() - startTime}ms)`);
            conn.exec(command, (err, stream) => {
                if (err) {
                    console.error(`${ts()} [EXEC] exec() ERROR: ${err.message}`);
                    conn.end();
                    return reject(err);
                }

                console.log(`${ts()} [EXEC] Stream opened, waiting for data...`);
                let stdout = '';
                let stderr = '';

                stream.on('close', (code, signal) => {
                    const elapsed = Date.now() - startTime;
                    console.log(`${ts()} [EXEC] Stream CLOSED - code=${code}, signal=${signal}, elapsed=${elapsed}ms`);
                    console.log(`${ts()} [EXEC] STDOUT (${stdout.length} chars): ${stdout.substring(0, 500)}`);
                    if (stderr) console.log(`${ts()} [EXEC] STDERR (${stderr.length} chars): ${stderr.substring(0, 500)}`);
                    console.log(`${ts()} [EXEC] Result: ${code === 0 ? 'SUCCESS' : 'FAILED'}`);
                    console.log(`${ts()} [EXEC] ──────────────────────────────────────`);
                    conn.end();
                    resolve({ success: code === 0, output: stdout, error: stderr, code });
                }).on('data', (data) => {
                    stdout += data;
                }).stderr.on('data', (data) => {
                    stderr += data;
                });
            });
        }).on('error', (err) => {
            console.error(`${ts()} [EXEC] SSH CONNECTION ERROR: ${err.message}`);
            console.error(`${ts()} [EXEC] Error code: ${err.code || 'N/A'}`);
            console.error(`${ts()} [EXEC] Elapsed: ${Date.now() - startTime}ms`);
            reject(err);
        }).connect(config);

        console.log(`${ts()} [EXEC] Connecting to SSH...`);
    });
};

/**
 * 1. List Sites in CloudPanel
 */
const listSites = async () => {
    console.log(`${ts()} [LIST_SITES] Starting...`);
    try {
        const cmd = `find /home -maxdepth 3 -type d -path "*/htdocs/*" -exec basename {} \\;`;
        console.log(`${ts()} [LIST_SITES] Running find command...`);
        const res = await execCommand(cmd);

        if (res.success) {
            const sites = res.output.trim().split('\n')
                .filter(s => s && !s.includes(' ') && s !== 'htdocs');
            const uniqueSites = [...new Set(sites)];
            console.log(`${ts()} [LIST_SITES] Found ${uniqueSites.length} sites: ${uniqueSites.join(', ')}`);
            return { success: true, sites: uniqueSites };
        }
        console.log(`${ts()} [LIST_SITES] FAILED: ${res.error}`);
        return { success: false, message: res.error };
    } catch (err) {
        console.error(`${ts()} [LIST_SITES] ERROR: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 2. Create Site in CloudPanel
 */
const createSite = async (domain) => {
    console.log(`${ts()} [CREATESITE] ══════════════════════════════════`);
    console.log(`${ts()} [CREATESITE] Creating site: ${domain}`);
    try {
        const domainClean = domain.replace(/[^a-z0-9]/g, '').substring(0, 10);
        const randomSuffix = Math.random().toString(36).substring(2, 6);
        const siteUser = `${domainClean}${randomSuffix}`;
        const sitePassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8) + '!';

        console.log(`${ts()} [CREATESITE] Generated user: ${siteUser}`);

        const cmd = `clpctl site:add:php --domainName=${domain} --phpVersion=8.2 --vhostTemplate=Generic --siteUser=${siteUser} --siteUserPassword=${sitePassword}`;
        console.log(`${ts()} [CREATESITE] Executing clpctl...`);
        const res = await execCommand(cmd);

        console.log(`${ts()} [CREATESITE] Result: success=${res.success}, code=${res.code}`);
        console.log(`${ts()} [CREATESITE] Output: ${res.output.substring(0, 300)}`);
        if (res.error) console.log(`${ts()} [CREATESITE] Error: ${res.error.substring(0, 300)}`);

        if (res.success) {
            console.log(`${ts()} [CREATESITE] Site created successfully`);
            return { success: true, message: 'Site created successfully', siteUser: siteUser };
        }

        const fullOutput = (res.error + res.output).toLowerCase();
        if (fullOutput.includes('already exists')) {
            console.log(`${ts()} [CREATESITE] Site already exists, finding existing user...`);
            const findPath = await execCommand(`find /home -maxdepth 3 -type d -path "*/htdocs/${domain}"`);
            const actualPath = findPath.output.trim();
            let actualUser = siteUser;
            if (actualPath) {
                actualUser = actualPath.split('/')[2];
                console.log(`${ts()} [CREATESITE] Found existing user: ${actualUser} at path: ${actualPath}`);
            } else {
                console.log(`${ts()} [CREATESITE] WARNING: Site reported as existing but directory not found!`);
            }
            return { success: true, message: 'Site already exists, skipping creation', siteUser: actualUser, alreadyExists: true };
        }

        console.log(`${ts()} [CREATESITE] FAILED to create site`);
        console.log(`${ts()} [CREATESITE] ══════════════════════════════════`);
        return { success: false, message: res.error || res.output };
    } catch (err) {
        console.error(`${ts()} [CREATESITE] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 3. Clone Files (Source -> Target)
 */
const cloneSiteFiles = async (sourceDomain, targetDomain) => {
    const startTime = Date.now();
    console.log(`${ts()} [CLONE] ══════════════════════════════════`);
    console.log(`${ts()} [CLONE] Source: ${sourceDomain} → Target: ${targetDomain}`);
    try {
        // 1. Find Source Path
        console.log(`${ts()} [CLONE] Step 1: Finding source path...`);
        const findSource = await execCommand(`find /home -name "${sourceDomain}" -type d | grep "htdocs/${sourceDomain}$"`);
        const sourcePath = findSource.output.trim();
        console.log(`${ts()} [CLONE] Source path: ${sourcePath || 'NOT FOUND'}`);

        if (!sourcePath) {
            console.error(`${ts()} [CLONE] ABORT: Source site path not found`);
            return { success: false, message: 'Source site path not found' };
        }

        // 2. Find Target Path with retry
        let targetPath = '';
        let retries = 3;

        while (retries > 0 && !targetPath) {
            console.log(`${ts()} [CLONE] Step 2: Finding target path (attempt ${4 - retries}/3)...`);
            const findTarget = await execCommand(`find /home -name "${targetDomain}" -type d | grep "htdocs/${targetDomain}$"`);
            targetPath = findTarget.output.trim();
            console.log(`${ts()} [CLONE] Target path: ${targetPath || 'NOT FOUND'}`);

            if (!targetPath) {
                retries--;
                if (retries > 0) {
                    console.log(`${ts()} [CLONE] Waiting 2s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (!targetPath) {
            console.error(`${ts()} [CLONE] ABORT: Target path not found after 3 retries`);
            return { success: false, message: 'Target site path not found (Create site first)' };
        }

        const targetUser = targetPath.split('/')[2];
        console.log(`${ts()} [CLONE] Step 3: Target user: ${targetUser}`);
        console.log(`${ts()} [CLONE] Source: ${sourcePath}`);
        console.log(`${ts()} [CLONE] Target: ${targetPath}`);

        // 4. Perform Clone
        console.log(`${ts()} [CLONE] Step 4: Starting file copy...`);
        const commands = [
            `rm -rf ${targetPath}/*`,
            `cp -a ${sourcePath}/. ${targetPath}/`,
            `chown -R ${targetUser}:${targetUser} ${targetPath}`
        ];

        const cloneRes = await execCommand(commands.join(' && '));
        const elapsed = Date.now() - startTime;
        console.log(`${ts()} [CLONE] Result: ${cloneRes.success ? 'SUCCESS' : 'FAILED'} (${elapsed}ms)`);
        if (cloneRes.error) console.log(`${ts()} [CLONE] Error output: ${cloneRes.error}`);
        console.log(`${ts()} [CLONE] ══════════════════════════════════`);

        if (cloneRes.success) {
            return { success: true, source: sourcePath, target: targetPath };
        }
        return { success: false, message: cloneRes.error };

    } catch (err) {
        console.error(`${ts()} [CLONE] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 4. Verify SSH Connection
 */
const checkConnection = async () => {
    console.log(`${ts()} [SSH_CHECK] Testing SSH connection...`);
    console.log(`${ts()} [SSH_CHECK] Host: ${config.host}, Port: ${config.port}, User: ${config.username}, Auth: privateKey`);
    try {
        const res = await execCommand('echo "Ready"');
        const isReady = res.success && res.output.trim() === 'Ready';
        console.log(`${ts()} [SSH_CHECK] Result: ${isReady ? 'CONNECTED' : 'FAILED'}`);
        return isReady;
    } catch (err) {
        console.error(`${ts()} [SSH_CHECK] CONNECTION FAILED: ${err.message}`);
        return false;
    }
};

/**
 * 6. Create Database & User
 */
const createDatabase = async (domain, dbName, dbUser, dbPass) => {
    console.log(`${ts()} [DB_CREATE] ══════════════════════════════════`);
    console.log(`${ts()} [DB_CREATE] Domain: ${domain}, DB: ${dbName}, User: ${dbUser}`);
    try {
        const cmd = `clpctl db:add --domainName=${domain} --databaseName=${dbName} --databaseUserName=${dbUser} --databaseUserPassword=${dbPass}`;
        console.log(`${ts()} [DB_CREATE] Executing clpctl db:add...`);
        const res = await execCommand(cmd);

        console.log(`${ts()} [DB_CREATE] Result: success=${res.success}, code=${res.code}`);
        console.log(`${ts()} [DB_CREATE] Output: ${res.output.substring(0, 300)}`);
        if (res.error) console.log(`${ts()} [DB_CREATE] Error: ${res.error.substring(0, 300)}`);

        if (res.success) {
            console.log(`${ts()} [DB_CREATE] Database created successfully`);
            return { success: true };
        }
        console.error(`${ts()} [DB_CREATE] FAILED`);
        console.log(`${ts()} [DB_CREATE] ══════════════════════════════════`);
        return { success: false, message: res.error || res.output };
    } catch (err) {
        console.error(`${ts()} [DB_CREATE] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 7. Import SQL File
 */
const importSql = async (dbName, dbUser, dbPass, sqlFilePath) => {
    console.log(`${ts()} [SQL_IMPORT] ══════════════════════════════════`);
    console.log(`${ts()} [SQL_IMPORT] DB: ${dbName}, User: ${dbUser}, File: ${sqlFilePath}`);
    try {
        const cmd = `mysql -u ${dbUser} -p'${dbPass}' ${dbName} -e "SET FOREIGN_KEY_CHECKS=0; SOURCE ${sqlFilePath}; SET FOREIGN_KEY_CHECKS=1;"`;
        console.log(`${ts()} [SQL_IMPORT] Executing mysql import...`);
        const res = await execCommand(cmd);

        console.log(`${ts()} [SQL_IMPORT] Import result: success=${res.success}, code=${res.code}`);
        if (res.error) console.log(`${ts()} [SQL_IMPORT] Stderr: ${res.error.substring(0, 500)}`);

        // Clean up SQL file after import
        console.log(`${ts()} [SQL_IMPORT] Cleaning up SQL file...`);
        await execCommand(`rm ${sqlFilePath}`);

        if (res.success) {
            console.log(`${ts()} [SQL_IMPORT] Import completed successfully`);
            return { success: true };
        }
        console.log(`${ts()} [SQL_IMPORT] Import FAILED`);
        console.log(`${ts()} [SQL_IMPORT] ══════════════════════════════════`);
        return { success: false, message: res.error || res.output };
    } catch (err) {
        console.error(`${ts()} [SQL_IMPORT] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 8. Execute SQL Query
 */
const executeQuery = async (dbName, dbUser, dbPass, query) => {
    console.log(`${ts()} [SQL_QUERY] DB: ${dbName}, Query: ${query.substring(0, 100)}`);
    try {
        const cmd = `mysql -u ${dbUser} -p'${dbPass}' ${dbName} -N -s -e "${query}"`;
        const res = await execCommand(cmd);
        console.log(`${ts()} [SQL_QUERY] Result: success=${res.success}, output=${res.output.substring(0, 200)}`);
        return { success: res.success, output: res.output, message: res.error };
    } catch (err) {
        console.error(`${ts()} [SQL_QUERY] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 9. Unzip & Deploy Files from MEGA (via remote zip path)
 */
const deployZip = async (domain, zipFilePath, onProgress = null) => {
    const startTime = Date.now();
    console.log(`${ts()} [DEPLOY] ══════════════════════════════════════════`);
    console.log(`${ts()} [DEPLOY] Domain: ${domain}`);
    console.log(`${ts()} [DEPLOY] Zip file: ${zipFilePath}`);
    console.log(`${ts()} [DEPLOY] Has progress callback: ${!!onProgress}`);

    try {
        if (onProgress) onProgress('⏳ Starting deploy...');

        // 1. Get Site Path
        console.log(`${ts()} [DEPLOY] Step 1/9: Finding site path...`);
        const findPath = await execCommand(`find /home -name "${domain}" -type d | grep "htdocs/${domain}$"`);
        const sitePath = findPath.output.trim();
        console.log(`${ts()} [DEPLOY] Site path result: "${sitePath}"`);
        console.log(`${ts()} [DEPLOY] Find command success: ${findPath.success}, code: ${findPath.code}`);
        if (findPath.error) console.log(`${ts()} [DEPLOY] Find stderr: ${findPath.error}`);

        if (!sitePath) {
            console.error(`${ts()} [DEPLOY] ABORT: Site path not found for ${domain}`);
            return { success: false, message: 'Site path not found' };
        }

        // 2. Get User
        const siteUser = sitePath.split('/')[2];
        console.log(`${ts()} [DEPLOY] Step 2/9: Site user: ${siteUser}`);

        // 3. Verify zip exists on server
        console.log(`${ts()} [DEPLOY] Step 3/9: Verifying zip file exists on server...`);
        const checkZip = await execCommand(`ls -la ${zipFilePath}`);
        console.log(`${ts()} [DEPLOY] Zip check: success=${checkZip.success}, output=${checkZip.output.trim()}`);
        if (!checkZip.success) {
            console.error(`${ts()} [DEPLOY] ABORT: Zip file does NOT exist on server at ${zipFilePath}`);
            console.error(`${ts()} [DEPLOY] This means the SFTP upload failed or file was not transferred`);
            return { success: false, message: `Zip file not found on server: ${zipFilePath}` };
        }

        // 4. Unzip
        if (onProgress) onProgress('📦 Unzipping files...');
        console.log(`${ts()} [DEPLOY] Step 4/9: Unzipping to ${sitePath}/...`);
        const unzipCmd = `unzip -o ${zipFilePath} -d ${sitePath}/`;
        console.log(`${ts()} [DEPLOY] Unzip command: ${unzipCmd}`);
        const unzipRes = await execCommand(unzipCmd);
        console.log(`${ts()} [DEPLOY] Unzip result: success=${unzipRes.success}, code=${unzipRes.code}`);
        console.log(`${ts()} [DEPLOY] Unzip stdout (first 500): ${unzipRes.output.substring(0, 500)}`);
        if (unzipRes.error) console.log(`${ts()} [DEPLOY] Unzip stderr: ${unzipRes.error.substring(0, 500)}`);
        if (!unzipRes.success) {
            console.error(`${ts()} [DEPLOY] ABORT: Unzip FAILED`);
            throw new Error(`Unzip failed: ${unzipRes.error}`);
        }

        // 5. Install Livewire
        if (onProgress) onProgress('🔧 Installing Livewire...');
        console.log(`${ts()} [DEPLOY] Step 5/9: Installing Livewire...`);
        const livewireRes = await execCommand(`cd ${sitePath}/base && composer require livewire/livewire --no-interaction`);
        console.log(`${ts()} [DEPLOY] Livewire: success=${livewireRes.success}, code=${livewireRes.code}`);
        if (livewireRes.error) console.log(`${ts()} [DEPLOY] Livewire stderr (first 300): ${livewireRes.error.substring(0, 300)}`);

        // 6. Route Clear
        if (onProgress) onProgress('🧹 Clearing routes...');
        console.log(`${ts()} [DEPLOY] Step 6/9: Running route:clear...`);
        const routeClearRes = await execCommand(`cd ${sitePath}/base && php artisan route:clear`);
        console.log(`${ts()} [DEPLOY] route:clear: success=${routeClearRes.success}, output=${routeClearRes.output.trim()}`);

        // 7. Config Clear
        if (onProgress) onProgress('🧹 Clearing config...');
        console.log(`${ts()} [DEPLOY] Step 7/9: Running config:clear...`);
        const configClearRes = await execCommand(`cd ${sitePath}/base && php artisan config:clear`);
        console.log(`${ts()} [DEPLOY] config:clear: success=${configClearRes.success}, output=${configClearRes.output.trim()}`);

        // 8. Cache Clear
        if (onProgress) onProgress('🧹 Clearing cache...');
        console.log(`${ts()} [DEPLOY] Step 8/9: Running cache:clear...`);
        const cacheClearRes = await execCommand(`cd ${sitePath}/base && php artisan cache:clear`);
        console.log(`${ts()} [DEPLOY] cache:clear: success=${cacheClearRes.success}, output=${cacheClearRes.output.trim()}`);

        // 9. Set permissions
        if (onProgress) onProgress('🔐 Setting permissions...');
        console.log(`${ts()} [DEPLOY] Step 9/9: Setting permissions (chown)...`);
        const chownRes = await execCommand(`chown -R ${siteUser}:${siteUser} ${sitePath}`);
        console.log(`${ts()} [DEPLOY] Chown: success=${chownRes.success}`);

        // 10. Remove zip file from server
        console.log(`${ts()} [DEPLOY] Cleanup: Removing zip from server...`);
        const rmRes = await execCommand(`rm ${zipFilePath}`);
        console.log(`${ts()} [DEPLOY] Remove zip: success=${rmRes.success}`);

        const allSuccess = unzipRes.success && chownRes.success && rmRes.success;
        const elapsed = Date.now() - startTime;

        console.log(`${ts()} [DEPLOY] ── SUMMARY ──`);
        console.log(`${ts()} [DEPLOY] Unzip: ${unzipRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Livewire: ${livewireRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Route Clear: ${routeClearRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Config Clear: ${configClearRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Cache Clear: ${cacheClearRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Chown: ${chownRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Zip Removed: ${rmRes.success ? '✅' : '❌'}`);
        console.log(`${ts()} [DEPLOY] Overall: ${allSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
        console.log(`${ts()} [DEPLOY] Total elapsed: ${elapsed}ms`);
        console.log(`${ts()} [DEPLOY] ══════════════════════════════════════════`);

        if (allSuccess) {
            if (onProgress) onProgress('✅ Deploy completed!');
            return { success: true, sitePath, livewire: livewireRes.success };
        }
        return { success: false, message: 'Some commands failed. Check logs above.' };
    } catch (err) {
        console.error(`${ts()} [DEPLOY] EXCEPTION: ${err.message}`);
        console.error(`${ts()} [DEPLOY] Stack: ${err.stack}`);
        if (onProgress) onProgress(`❌ Error: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 10. Update .env File
 */
const updateEnvFile = async (domain, dbName, dbUser, dbPass) => {
    console.log(`${ts()} [ENV_UPDATE] ══════════════════════════════════`);
    console.log(`${ts()} [ENV_UPDATE] Domain: ${domain}, DB: ${dbName}, User: ${dbUser}`);
    try {
        console.log(`${ts()} [ENV_UPDATE] Finding site path...`);
        const findPath = await execCommand(`find /home -name "${domain}" -type d | grep "htdocs/${domain}$"`);
        const siteRoot = findPath.output.trim();
        console.log(`${ts()} [ENV_UPDATE] Site root: ${siteRoot || 'NOT FOUND'}`);

        if (!siteRoot) return { success: false, message: 'Site path not found for .env update' };

        // Check if .env is in site root or /base/ subdirectory
        console.log(`${ts()} [ENV_UPDATE] Checking for .env locations...`);
        const checkRootEnv = await execCommand(`ls ${siteRoot}/.env`);
        const checkBaseEnv = await execCommand(`ls ${siteRoot}/base/.env`);

        console.log(`${ts()} [ENV_UPDATE] Root .env exists: ${checkRootEnv.success}`);
        console.log(`${ts()} [ENV_UPDATE] Base .env exists: ${checkBaseEnv.success}`);

        let envPath = '';
        if (checkBaseEnv.success) {
            envPath = `${siteRoot}/base/.env`;
        } else if (checkRootEnv.success) {
            envPath = `${siteRoot}/.env`;
        } else {
            console.error(`${ts()} [ENV_UPDATE] ABORT: No .env file found`);
            return { success: false, message: `.env file not found in ${siteRoot} or ${siteRoot}/base/` };
        }

        console.log(`${ts()} [ENV_UPDATE] Using .env at: ${envPath}`);

        const commands = [
            `sed -i "s|^[[:space:]]*DB_HOST[[:space:]]*=.*|DB_HOST=127.0.0.1|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*DB_PORT[[:space:]]*=.*|DB_PORT=3306|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*DB_DATABASE[[:space:]]*=.*|DB_DATABASE=${dbName}|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*DB_USERNAME[[:space:]]*=.*|DB_USERNAME=${dbUser}|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*DB_PASSWORD[[:space:]]*=.*|DB_PASSWORD='${dbPass}'|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*APP_URL[[:space:]]*=.*|APP_URL=https://${domain}|g" ${envPath}`,
            `sed -i "s|^[[:space:]]*APP_NAME[[:space:]]*=.*|APP_NAME=${domain.split('.')[0].toUpperCase()}|g" ${envPath}`
        ];

        console.log(`${ts()} [ENV_UPDATE] Running ${commands.length} sed commands...`);
        const res = await execCommand(commands.join(' && '));
        console.log(`${ts()} [ENV_UPDATE] Result: success=${res.success}`);
        if (res.error) console.log(`${ts()} [ENV_UPDATE] Error: ${res.error}`);
        console.log(`${ts()} [ENV_UPDATE] ══════════════════════════════════`);
        return { success: res.success, message: res.error };
    } catch (err) {
        console.error(`${ts()} [ENV_UPDATE] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 11. Upload File via SFTP (from MEGA temp download → remote server)
 */
const uploadFile = (sourcePath, remotePath, onProgress) => {
    const startTime = Date.now();
    console.log(`${ts()} [SFTP_UPLOAD] ══════════════════════════════════`);
    console.log(`${ts()} [SFTP_UPLOAD] Source: ${sourcePath}`);
    console.log(`${ts()} [SFTP_UPLOAD] Remote: ${remotePath}`);
    console.log(`${ts()} [SFTP_UPLOAD] SSH Config: host=${config.host}, port=${config.port}, user=${config.username}, auth=privateKey`);

    return new Promise((resolve, reject) => {
        // Check if source file exists
        const fs = require('fs');
        if (!fs.existsSync(sourcePath)) {
            const errMsg = `Source file does NOT exist: ${sourcePath}`;
            console.error(`${ts()} [SFTP_UPLOAD] ABORT: ${errMsg}`);
            return reject(new Error(errMsg));
        }

        const stats = fs.statSync(sourcePath);
        const fileSize = stats.size;
        console.log(`${ts()} [SFTP_UPLOAD] File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB (${fileSize} bytes)`);

        const conn = new Client();

        conn.on('ready', () => {
            console.log(`${ts()} [SFTP_UPLOAD] SSH connected (took ${Date.now() - startTime}ms)`);
            console.log(`${ts()} [SFTP_UPLOAD] Opening SFTP session...`);

            conn.sftp((err, sftp) => {
                if (err) {
                    console.error(`${ts()} [SFTP_UPLOAD] SFTP session ERROR: ${err.message}`);
                    conn.end();
                    return reject(err);
                }

                console.log(`${ts()} [SFTP_UPLOAD] SFTP session opened, starting file transfer...`);
                let lastSent = 0;

                const readStream = fs.createReadStream(sourcePath);
                const writeStream = sftp.createWriteStream(remotePath);

                writeStream.on('close', () => {
                    const elapsed = Date.now() - startTime;
                    console.log(`${ts()} [SFTP_UPLOAD] ✅ Transfer COMPLETE (${elapsed}ms)`);
                    console.log(`${ts()} [SFTP_UPLOAD] File uploaded to: ${remotePath}`);
                    console.log(`${ts()} [SFTP_UPLOAD] ══════════════════════════════════`);
                    conn.end();
                    resolve({ success: true });
                });

                writeStream.on('error', (err) => {
                    console.error(`${ts()} [SFTP_UPLOAD] Write stream ERROR: ${err.message}`);
                    conn.end();
                    reject(err);
                });

                readStream.on('error', (err) => {
                    console.error(`${ts()} [SFTP_UPLOAD] Read stream ERROR: ${err.message}`);
                    conn.end();
                    reject(err);
                });

                let uploaded = 0;
                readStream.on('data', (chunk) => {
                    uploaded += chunk.length;
                    const percent = Math.floor((uploaded / fileSize) * 100);

                    if (percent >= lastSent + 5 && onProgress) {
                        lastSent = percent;
                        console.log(`${ts()} [SFTP_UPLOAD] Progress: ${percent}% (${(uploaded / 1024 / 1024).toFixed(2)}MB / ${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
                        onProgress(percent);
                    }
                });

                readStream.pipe(writeStream);
            });
        }).on('error', (err) => {
            console.error(`${ts()} [SFTP_UPLOAD] SSH CONNECTION ERROR: ${err.message}`);
            console.error(`${ts()} [SFTP_UPLOAD] Error code: ${err.code || 'N/A'}`);
            console.error(`${ts()} [SFTP_UPLOAD] Elapsed: ${Date.now() - startTime}ms`);
            reject(err);
        }).connect(config);

        console.log(`${ts()} [SFTP_UPLOAD] Connecting to SSH for SFTP...`);
    });
};

/**
 * 12. Add Cron Job
 */
const addCronJob = async (domain, siteUser, cronJob) => {
    console.log(`${ts()} [CRON] Adding cron job for ${domain}, user: ${siteUser}`);
    console.log(`${ts()} [CRON] Job: ${cronJob}`);
    try {
        const cmd = `(crontab -u ${siteUser} -l 2>/dev/null | grep -Fv "${cronJob}"; echo "${cronJob}") | crontab -u ${siteUser} -`;
        const res = await execCommand(cmd);

        console.log(`${ts()} [CRON] Result: success=${res.success}`);
        if (res.error) console.log(`${ts()} [CRON] Error: ${res.error}`);

        if (res.success) {
            return { success: true, message: 'Cron job added successfully' };
        }
        return { success: false, message: res.error || res.output };
    } catch (err) {
        console.error(`${ts()} [CRON] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * 13. Cron-job.org API Integration
 */
const cronJobOrg = {
    listJobs: async () => {
        console.log(`${ts()} [CRON_ORG] Listing all jobs...`);
        try {
            const response = await axios.get(`${CRON_JOB_ORG_BASE_URL}/jobs`, {
                headers: {
                    'Authorization': `Bearer ${CRON_JOB_ORG_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`${ts()} [CRON_ORG] Found ${response.data.jobs?.length || 0} jobs`);
            return { success: true, jobs: response.data.jobs };
        } catch (error) {
            console.error(`${ts()} [CRON_ORG] List jobs ERROR: ${error.response?.data?.message || error.message}`);
            return { success: false, message: error.response?.data?.message || error.message };
        }
    },

    createJob: async (title, url, scheduleMinutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) => {
        console.log(`${ts()} [CRON_ORG] Creating job: ${title}, URL: ${url}`);
        try {
            const payload = {
                job: {
                    title: title,
                    url: url,
                    enabled: true,
                    saveResponses: true,
                    schedule: {
                        timezone: 'UTC',
                        hours: [-1],
                        mdays: [-1],
                        months: [-1],
                        wdays: [-1],
                        minutes: scheduleMinutes
                    }
                }
            };

            const response = await axios.put(`${CRON_JOB_ORG_BASE_URL}/jobs`, payload, {
                headers: {
                    'Authorization': `Bearer ${CRON_JOB_ORG_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`${ts()} [CRON_ORG] Job created: ID=${response.data.jobId}`);
            return { success: true, jobId: response.data.jobId };
        } catch (error) {
            console.error(`${ts()} [CRON_ORG] Create job ERROR: ${error.response?.data?.message || error.message}`);
            return { success: false, message: error.response?.data?.message || error.message };
        }
    },

    findJobByUrl: async (url) => {
        console.log(`${ts()} [CRON_ORG] Finding job by URL: ${url}`);
        const res = await cronJobOrg.listJobs();
        if (res.success) {
            const job = res.jobs.find(j => j.url === url);
            console.log(`${ts()} [CRON_ORG] Job found: ${job ? `ID=${job.jobId}` : 'NOT FOUND'}`);
            return { success: true, job: job };
        }
        return res;
    }
};

/**
 * 7. Get Admin Prefix from Database
 */
const getAdminPrefix = async (domain) => {
    console.log(`${ts()} [ADMIN_PREFIX] Getting admin prefix for: ${domain}`);
    try {
        const findPath = await execCommand(`find /home -maxdepth 3 -type d -path "*/htdocs/${domain}"`);
        const sitePath = findPath.output.trim();
        if (!sitePath) {
            console.log(`${ts()} [ADMIN_PREFIX] Site path not found`);
            return { success: false, message: 'Site path not found' };
        }

        console.log(`${ts()} [ADMIN_PREFIX] Site path: ${sitePath}`);

        const envPathCmd = `find ${sitePath} -name ".env" | grep -v "telegrambot" | head -n 1`;
        const envPathRes = await execCommand(envPathCmd);
        const envPath = envPathRes.output.trim();

        if (!envPath) {
            console.log(`${ts()} [ADMIN_PREFIX] .env not found`);
            return { success: false, message: 'Database .env file not found' };
        }

        console.log(`${ts()} [ADMIN_PREFIX] .env path: ${envPath}`);

        const dbNameCmd = `grep "DB_DATABASE" ${envPath} | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' '`;
        const dbUserCmd = `grep "DB_USERNAME" ${envPath} | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' '`;
        const dbPassCmd = `grep "DB_PASSWORD" ${envPath} | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' '`;

        const [dbNameRes, dbUserRes, dbPassRes] = await Promise.all([
            execCommand(dbNameCmd),
            execCommand(dbUserCmd),
            execCommand(dbPassCmd)
        ]);

        const dbName = dbNameRes.output.trim();
        const dbUser = dbUserRes.output.trim();
        const dbPass = dbPassRes.output.trim();

        console.log(`${ts()} [ADMIN_PREFIX] DB credentials: name=${dbName}, user=${dbUser}, pass=${dbPass ? '***' : 'EMPTY'}`);

        if (!dbName || !dbUser) {
            console.log(`${ts()} [ADMIN_PREFIX] DB credentials missing`);
            return { success: false, message: 'Database credentials not found' };
        }

        const queries = [
            "SELECT admin_route_prefix FROM general LIMIT 1;",
            "SELECT value FROM settings WHERE \\`key\\`='admin_prefix' LIMIT 1;",
            "SELECT value FROM settings WHERE \\`key\\`='admin_route_prefix' LIMIT 1;"
        ];

        for (const query of queries) {
            console.log(`${ts()} [ADMIN_PREFIX] Trying query: ${query}`);
            const dbRes = await executeQuery(dbName, dbUser, dbPass, query);
            const output = dbRes.output ? dbRes.output.trim() : "";

            if (dbRes.success && output) {
                console.log(`${ts()} [ADMIN_PREFIX] Found prefix: ${output}`);
                return { success: true, prefix: output };
            }
        }

        // Fallback: Check folder
        console.log(`${ts()} [ADMIN_PREFIX] DB queries failed, checking folder fallback...`);
        const dirCmd = `ls -d ${sitePath}/admin* 2>/dev/null | head -n 1 | xargs basename`;
        const dirRes = await execCommand(dirCmd);
        if (dirRes.success && dirRes.output.trim()) {
            console.log(`${ts()} [ADMIN_PREFIX] Folder fallback found: ${dirRes.output.trim()}`);
            return { success: true, prefix: dirRes.output.trim() };
        }

        console.log(`${ts()} [ADMIN_PREFIX] Could not detect admin prefix`);
        return { success: false, message: 'Could not detect admin prefix from database' };
    } catch (err) {
        console.error(`${ts()} [ADMIN_PREFIX] EXCEPTION: ${err.message}`);
        return { success: false, message: err.message };
    }
};

/**
 * Cloudzy VPS Health Check & Auto-Restart Module
 */
const CLOUDZY_API_TOKEN = process.env.CLOUDZY_API_TOKEN || '730cd83e-3415-44eb-baf0-cf234d8b0cde';
const CLOUDZY_API_BASE_URL = 'https://api.cloudzy.com/developers/v1';

const cloudzyRequest = async (endpoint, method = 'GET', body = null) => {
    const url = `${CLOUDZY_API_BASE_URL}${endpoint}`;
    const options = {
        method,
        url,
        headers: {
            'API-Token': CLOUDZY_API_TOKEN,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.data = body;
    }

    try {
        console.log(`${ts()} [CLOUDZY] ${method} ${url}`);
        const response = await axios(options);
        console.log(`${ts()} [CLOUDZY] Response: ${response.status}`, JSON.stringify(response.data, null, 2));
        return { success: true, data: response.data };
    } catch (err) {
        const errorData = err.response?.data || err.message;
        console.error(`${ts()} [CLOUDZY] Error ${method} ${url}:`, JSON.stringify(errorData, null, 2));
        return { success: false, error: errorData, status: err.response?.status };
    }
};

const listCloudzyInstances = async () => {
    console.log(`${ts()} [CLOUDZY] Listing all instances...`);
    const result = await cloudzyRequest('/instances');

    if (result.success && result.data.code === 'OKAY') {
        const instances = result.data.data?.instances || [];
        console.log(`${ts()} [CLOUDZY] Found ${instances.length} instances`);
        instances.forEach(inst => {
            console.log(`${ts()} [CLOUDZY] Instance: ${inst.hostname} (${inst.id}) - Status: ${inst.status} - IP: ${inst.mainIp}`);
        });
        return { success: true, instances };
    }

    return { success: false, message: result.data?.detail || 'Failed to list instances' };
};

const getCloudzyInstance = async (instanceId) => {
    console.log(`${ts()} [CLOUDZY] Getting instance details for ${instanceId}...`);
    const result = await cloudzyRequest(`/instances/${instanceId}`);

    if (result.success && result.data.code === 'OKAY') {
        const instance = result.data.data;
        console.log(`${ts()} [CLOUDZY] Instance ${instanceId}:`, {
            hostname: instance.hostname,
            status: instance.status,
            mainIp: instance.mainIp,
            networkStatus: instance.networkStatus
        });
        return { success: true, instance };
    }

    return { success: false, message: result.data?.detail || 'Failed to get instance details' };
};

const findCloudzyInstance = async (hostnameOrIp) => {
    console.log(`${ts()} [CLOUDZY] Searching for instance: ${hostnameOrIp}`);
    const listResult = await listCloudzyInstances();

    if (!listResult.success) {
        return listResult;
    }

    const instance = listResult.instances.find(inst =>
        inst.hostname === hostnameOrIp ||
        inst.mainIp === hostnameOrIp
    );

    if (instance) {
        console.log(`${ts()} [CLOUDZY] Found matching instance: ${instance.id} (${instance.hostname})`);
        return { success: true, instance };
    }

    console.log(`${ts()} [CLOUDZY] No instance found matching: ${hostnameOrIp}`);
    return { success: false, message: `Instance not found: ${hostnameOrIp}` };
};

const powerOnCloudzyInstance = async (instanceId) => {
    console.log(`${ts()} [CLOUDZY] Sending POWER ON to ${instanceId}...`);
    const result = await cloudzyRequest(`/instances/${instanceId}/poweron`, 'POST');

    if (result.success && result.data.code === 'OKAY') {
        console.log(`${ts()} [CLOUDZY] Power on request sent successfully`);
        return { success: true, message: 'Power on request sent successfully' };
    }

    return { success: false, message: result.data?.detail || 'Failed to power on instance' };
};

const checkAndRestartVPS = async (hostnameOrIp) => {
    console.log(`\n${ts()} ========== [VPS HEALTH CHECK] ==========`);
    console.log(`${ts()} [VPS CHECK] Target: ${hostnameOrIp}`);

    try {
        const findResult = await findCloudzyInstance(hostnameOrIp);
        if (!findResult.success) {
            console.error(`${ts()} [VPS CHECK] Instance not found: ${findResult.message}`);
            return { success: false, wasRestarted: false, message: findResult.message };
        }

        const instance = findResult.instance;
        console.log(`${ts()} [VPS CHECK] Instance: ${instance.hostname} (${instance.id})`);
        console.log(`${ts()} [VPS CHECK] Status: ${instance.status}`);
        console.log(`${ts()} [VPS CHECK] Network: ${instance.networkStatus}`);
        console.log(`${ts()} [VPS CHECK] IP: ${instance.mainIp}`);

        const isAlive = instance.status === 'active' && instance.networkStatus === 'active';

        if (isAlive) {
            console.log(`${ts()} [VPS CHECK] ✅ VPS is HEALTHY`);
            console.log(`${ts()} ========== [VPS CHECK COMPLETE] ==========\n`);
            return {
                success: true,
                wasRestarted: false,
                message: 'VPS is healthy and running',
                instance: {
                    id: instance.id,
                    hostname: instance.hostname,
                    status: instance.status,
                    ip: instance.mainIp
                }
            };
        }

        console.log(`${ts()} [VPS CHECK] ⚠️ VPS is NOT RUNNING - initiating restart...`);

        const powerOnResult = await powerOnCloudzyInstance(instance.id);

        if (powerOnResult.success) {
            console.log(`${ts()} [VPS CHECK] 🔄 RESTART command sent`);
            console.log(`${ts()} ========== [VPS CHECK COMPLETE - RESTARTED] ==========\n`);

            return {
                success: true,
                wasRestarted: true,
                message: `VPS was ${instance.status} - Restart initiated successfully`,
                instance: {
                    id: instance.id,
                    hostname: instance.hostname,
                    previousStatus: instance.status,
                    previousNetworkStatus: instance.networkStatus,
                    ip: instance.mainIp
                }
            };
        } else {
            console.error(`${ts()} [VPS CHECK] ❌ RESTART FAILED: ${powerOnResult.message}`);
            console.log(`${ts()} ========== [VPS CHECK COMPLETE - RESTART FAILED] ==========\n`);

            return {
                success: false,
                wasRestarted: false,
                message: `Failed to restart VPS: ${powerOnResult.message}`,
                instance: {
                    id: instance.id,
                    hostname: instance.hostname,
                    status: instance.status
                }
            };
        }

    } catch (err) {
        console.error(`${ts()} [VPS CHECK] CRITICAL ERROR: ${err.message}`);
        console.log(`${ts()} ========== [VPS CHECK COMPLETE - ERROR] ==========\n`);
        return {
            success: false,
            wasRestarted: false,
            message: `Health check error: ${err.message}`
        };
    }
};

const autoMonitorVPS = async (hostnameOrIp, bot = null, chatId = null) => {
    console.log(`${ts()} [AUTO-MONITOR] Running scheduled VPS health check...`);

    const result = await checkAndRestartVPS(hostnameOrIp);

    if (bot && chatId) {
        try {
            let message = '';
            if (result.wasRestarted) {
                message = `🔄 <b>VPS Auto-Restarted</b>\n\n`;
                message += `🖥️ <b>Hostname:</b> ${result.instance.hostname}\n`;
                message += `📍 <b>IP:</b> ${result.instance.ip}\n`;
                message += `⚠️ <b>Previous Status:</b> ${result.instance.previousStatus}\n`;
                message += `✅ <b>Action:</b> Restart initiated\n`;
                message += `⏰ <b>Time:</b> ${new Date().toLocaleString()}`;
            } else if (result.success) {
                message = `✅ <b>VPS Health Check</b>\n\n`;
                message += `🖥️ <b>Hostname:</b> ${result.instance.hostname}\n`;
                message += `📍 <b>IP:</b> ${result.instance.ip}\n`;
                message += `✅ <b>Status:</b> ${result.instance.status}\n`;
                message += `💚 <b>State:</b> Healthy\n`;
                message += `⏰ <b>Time:</b> ${new Date().toLocaleString()}`;
            } else {
                message = `❌ <b>VPS Health Check Failed</b>\n\n`;
                message += `🔍 <b>Target:</b> ${hostnameOrIp}\n`;
                message += `❌ <b>Error:</b> ${result.message}\n`;
                message += `⏰ <b>Time:</b> ${new Date().toLocaleString()}`;
            }

            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            console.log(`${ts()} [AUTO-MONITOR] Telegram notification sent to ${chatId}`);
        } catch (notifyErr) {
            console.error(`${ts()} [AUTO-MONITOR] Failed to send notification: ${notifyErr.message}`);
        }
    }

    return result;
};

module.exports = {
    checkConnection,
    listSites,
    createSite,
    cloneSiteFiles,
    createDatabase,
    importSql,
    executeQuery,
    deployZip,
    updateEnvFile,
    execCommand,
    uploadFile,
    addCronJob,
    cronJobOrg,
    getAdminPrefix,
    getSshConfig,
    // Cloudzy VPS functions
    listCloudzyInstances,
    getCloudzyInstance,
    findCloudzyInstance,
    powerOnCloudzyInstance,
    checkAndRestartVPS,
    autoMonitorVPS
};
