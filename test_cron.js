require('dotenv').config();
const serverManager = require('./serverManager');

async function testCron() {
    console.log('--- Testing Cron Job Automation ---');
    
    // Test parameters (using the domain from the error log)
    const domain = 'dee2re.biz';
    const siteUser = 'ee2rebiz'; // Corrected from log
    const cronJob = `*/5 * * * * curl -s https://${domain}/getcronhaha`;

    console.log(`Target: Domain=${domain}, User=${siteUser}`);
    console.log(`Command: ${cronJob}`);

    try {
        console.log('--- Listing clpctl commands ---');
        const listCmds = await serverManager.execCommand('clpctl list');
        console.log(listCmds.output);

        // Also check if there's an app-specific cron controller we can trigger
        console.log('--- Verifying Site ID 24 ---');
        const siteVerifyRes = await serverManager.execCommand('sqlite3 /home/clp/htdocs/app/data/db.sq3 "SELECT id, domain_name FROM site WHERE id = 24"');
        console.log(siteVerifyRes.output || siteVerifyRes.error);

        // Verify by listing crontab
        console.log('\n--- Verifying Crontab Content ---');
        const listRes = await serverManager.execCommand(`crontab -u ${siteUser} -l`);
        if (listRes.success) {
            console.log('Current Crontab:');
            console.log(listRes.output);
        } else {
            console.log('Failed to list crontab:', listRes.error);
        }

    } catch (err) {
        console.error('Test Error:', err);
    }
}

testCron();
