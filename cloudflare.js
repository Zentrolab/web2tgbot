
require('dotenv').config();
const axios = require('axios');

const CF_EMAIL = process.env.CF_EMAIL;
const CF_API_KEY = process.env.CF_API_KEY;
const TARGET_IP = process.env.TARGET_SERVER_IP;

const BASE_URL = 'https://api.cloudflare.com/client/v4';

const headers = {
    'X-Auth-Email': CF_EMAIL,
    'X-Auth-Key': CF_API_KEY,
    'Content-Type': 'application/json'
};

/**
 * 1. Add a new domain (Zone) to Cloudflare
 */
const addZone = async (domain) => {
    try {
        const response = await axios.post(`${BASE_URL}/zones`, {
            name: domain,
            jump_start: true
        }, { headers });

        if (response.data.success) {
            return {
                success: true,
                zoneId: response.data.result.id,
                nameservers: response.data.result.name_servers
            };
        }
        return { success: false, message: response.data.errors[0].message };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

/**
 * 2. Get Zone ID for a domain
 */
const getZoneId = async (domain) => {
    try {
        // Try exact match first
        let response = await axios.get(`${BASE_URL}/zones?name=${domain}`, { headers });
        
        // If no results, try contains search
        if (response.data.success && response.data.result.length === 0) {
            console.log(`[CF] Exact match not found, trying contains search...`);
            response = await axios.get(`${BASE_URL}/zones?name=contains:${domain}`, { headers });
        }
        
        if (response.data.success && response.data.result.length > 0) {
            // Find the exact domain match from results
            const zone = response.data.result.find(z => z.name === domain) || response.data.result[0];
            console.log(`[CF] Found zone: ${zone.name} (ID: ${zone.id})`);
            return { 
                success: true, 
                zoneId: zone.id,
                nameservers: zone.name_servers
            };
        }
        return { success: false, message: 'Zone not found' };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

/**
 * 2.1 List All Zones (Domains)
 * Supports pagination and name filtering
 */
const listZones = async (page = 1, name = '') => {
    try {
        let url = `${BASE_URL}/zones?page=${page}&per_page=20`;
        if (name) {
            url += `&name=contains:${name}`;
        }
        
        const response = await axios.get(url, { headers });
        
        if (response.data.success) {
            return {
                success: true,
                domains: response.data.result.map(z => ({
                    id: z.id,
                    name: z.name,
                    status: z.status,
                    paused: z.paused,
                    type: z.type,
                    name_servers: z.name_servers
                })),
                pagination: response.data.result_info
            };
        }
        return { success: false, message: response.data.errors[0].message };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

/**
 * 3. Point Domain to IP (Create A Record)
 */
const setDnsRecord = async (zoneId, domain, ip = TARGET_IP) => {
    try {
        // First check if record exists
        const check = await axios.get(`${BASE_URL}/zones/${zoneId}/dns_records?type=A&name=${domain}`, { headers });
        
        const data = {
            type: 'A',
            name: domain,
            content: ip,
            ttl: 1, // Auto
            proxied: true // Orange Cloud
        };

        if (check.data.success && check.data.result.length > 0) {
            // Update existing
            const recordId = check.data.result[0].id;
            const res = await axios.put(`${BASE_URL}/zones/${zoneId}/dns_records/${recordId}`, data, { headers });
            return { success: res.data.success, updated: true };
        } else {
            // Create new
            const res = await axios.post(`${BASE_URL}/zones/${zoneId}/dns_records`, data, { headers });
            return { success: res.data.success, created: true };
        }
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

/**
 * 3.1 Get DNS Records (A Records)
 */
const getDnsRecords = async (zoneId) => {
    try {
        const response = await axios.get(`${BASE_URL}/zones/${zoneId}/dns_records?type=A`, { headers });
        if (response.data.success) {
            return {
                success: true,
                records: response.data.result.map(r => ({
                    name: r.name,
                    content: r.content,
                    proxied: r.proxied
                }))
            };
        }
        return { success: false, message: response.data.errors[0].message };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

/**
 * 4. Full Setup: Add Domain + Point IP
 */
const autoSetup = async (domain, ip = TARGET_IP) => {
    console.log(`🚀 Starting Cloudflare Auto-Setup for: ${domain}`);
    
    // 1. Try to get existing Zone ID
    let zoneRes = await getZoneId(domain);
    let zoneId = zoneRes.zoneId;
    let nameservers = zoneRes.nameservers;

    if (!zoneRes.success) {
        console.log(`➕ Domain not in CF, adding now...`);
        const addRes = await addZone(domain);
        
        // If add failed because domain already exists, try to find it again
        if (!addRes.success && addRes.message && addRes.message.includes('already exists')) {
            console.log(`⚠️ Domain already exists message received, searching again...`);
            // Wait a moment and try to get zone ID again
            await new Promise(resolve => setTimeout(resolve, 2000));
            zoneRes = await getZoneId(domain);
            
            if (zoneRes.success) {
                zoneId = zoneRes.zoneId;
                nameservers = zoneRes.nameservers;
                console.log(`✅ Found existing zone: ${zoneId}`);
            } else {
                return { success: false, message: 'Domain exists but could not retrieve zone ID' };
            }
        } else if (!addRes.success) {
            return addRes;
        } else {
            zoneId = addRes.zoneId;
            nameservers = addRes.nameservers;
        }
    } else {
        console.log(`✅ Domain already in CF, using existing zone: ${zoneId}`);
    }

    console.log(`📍 Setting DNS A-Record to ${ip}...`);
    const dnsRes = await setDnsRecord(zoneId, domain, ip);
    
    return {
        success: dnsRes.success,
        domain: domain,
        zoneId: zoneId,
        ip: ip,
        nameservers: nameservers,
        message: dnsRes.success ? 'Domain added and pointed to IP successfully!' : dnsRes.message
    };
};

/**
 * 5. Set Security Level (Protection)
 * Levels: off, essentially_off, low, medium, high, under_attack
 */
const setSecurityLevel = async (zoneId, level = 'under_attack') => {
    try {
        const response = await axios.patch(`${BASE_URL}/zones/${zoneId}/settings/security_level`, {
            value: level
        }, { headers });
        
        return { success: response.data.success, level: response.data.result.value };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

/**
 * 6. Sync Firewall Rule
 */
const syncRule = async (zoneId, ruleName, expression, action, enabled) => {
    try {
        console.log(`[CF] syncRule: ${ruleName}, enabled: ${enabled}`);

        // Find existing rule
        const response = await axios.get(`${BASE_URL}/zones/${zoneId}/firewall/rules`, { headers });

        let existingRule = null;
        if (response.data.success) {
            for (const rule of response.data.result) {
                if (rule.description === ruleName) {
                    existingRule = rule;
                    break;
                }
            }
        }

        if (enabled) {
            if (existingRule) {
                console.log(`[CF] Updating existing rule: ${ruleName}`);
                const filterId = existingRule.filter.id;
                
                // Update filter first
                await axios.put(`${BASE_URL}/zones/${zoneId}/filters/${filterId}`, {
                    id: filterId,
                    expression: expression,
                    paused: false,
                }, { headers });
                
                // Update rule
                const ruleResponse = await axios.put(`${BASE_URL}/zones/${zoneId}/firewall/rules/${existingRule.id}`, {
                    id: existingRule.id,
                    action: action,
                    description: ruleName,
                    filter: { id: filterId },
                }, { headers });

                return { success: ruleResponse.data.success };
            } else {
                console.log(`[CF] Creating new rule: ${ruleName}`);
                // Create new filter
                const filterResponse = await axios.post(`${BASE_URL}/zones/${zoneId}/filters`, [{
                    expression: expression,
                    paused: false,
                    description: `${ruleName}_FILTER`,
                }], { headers });

                if (filterResponse.data.success) {
                    const filterId = filterResponse.data.result[0].id;
                    // Create new rule
                    const ruleResponse = await axios.post(`${BASE_URL}/zones/${zoneId}/firewall/rules`, [{
                        action: action,
                        description: ruleName,
                        filter: { id: filterId },
                    }], { headers });
                    
                    return { success: ruleResponse.data.success };
                }
            }
        } else {
            // Delete if exists
            if (existingRule) {
                console.log(`[CF] Deleting rule: ${ruleName}`);
                await axios.delete(`${BASE_URL}/zones/${zoneId}/firewall/rules/${existingRule.id}`, { headers });
                if (existingRule.filter && existingRule.filter.id) {
                    await axios.delete(`${BASE_URL}/zones/${zoneId}/filters/${existingRule.filter.id}`, { headers });
                }
                return { success: true };
            }
        }
        return { success: true };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        console.error(`[CF_ERROR] syncRule ${ruleName}:`, msg);
        return { success: false, message: msg };
    }
};

/**
 * 7. Update WAF Rules
 */
const updateWafRules = async (zoneId, options = {}) => {
    const { 
        enablePhOnly = false, 
        enableVpnBlocking = false, 
        enableAsnWhitelist = false,
        enableCountryWhitelist = false,
        whitelistedCountries = []
    } = options;

    console.log(`[CF] updateWafRules:`, { zoneId, enablePhOnly, enableVpnBlocking, enableAsnWhitelist, enableCountryWhitelist, whitelistedCountries });

    if (!zoneId) return { success: false, message: 'No Zone ID provided' };

    const results = [];
    const whitelistIps = '{116.203.129.16 116.203.134.67 23.88.105.37 128.140.8.200 91.99.23.109 38.54.37.225 104.194.153.179 66.94.123.166}';
    const bypassExpression = `(ip.src in ${whitelistIps})`;

    // 1. PH Only Rule
    results.push(await syncRule(zoneId, 'PH_ONLY_PROTECTION', `(not ${bypassExpression} and ip.geoip.country ne "PH")`, 'block', enablePhOnly));

    // 2. VPN/Proxy Rule (Enhanced with aggressive Data Center ASN blocking)
    // - cf.threat_score >= 10: High IP reputation risk
    // - Aggressive block of major VPN/Data Center ASNs (M247, NordVPN, OVH, DigitalOcean, etc.)
    const badAsns = '{9009 13678 60068 16276 14061 202425 212238 32097 206264 49392 50673 211252 205016 39351 209533 210558 13375 20473 14576 14618 16509 20473 45102 16276 62567 12876 24940 36352 15169 8075 20940 54113 25017 396982 204428}';
    results.push(await syncRule(zoneId, 'VPN_PROXY_PROTECTION', `(not ${bypassExpression} and (cf.threat_score ge 10 or ip.geoip.asnum in ${badAsns}))`, 'block', enableVpnBlocking));

    // 3. Legit PH ASN Only Rule (Comprehensive list covering Luzon, Visayas, and Mindanao)
    const legitAsns = '{10139 131173 131175 13123 131932 132044 132064 132148 132199 132203 132233 132796 133064 133202 133203 133204 133205 133464 134687 134707 134996 135421 135423 135607 136557 137404 138354 138965 139831 140608 141253 141381 147040 17534 17639 17651 17721 17855 17887 17970 18101 18151 18190 18206 18260 23930 23944 24492 24513 32212 3550 38227 38734 45117 45383 45456 45479 45542 45632 45638 45667 45754 45949 4608 4759 4768 4775 4777 4786 4795 4801 4811 55547 55670 55821 56099 56207 6648 7629 7635 9299 9317 9467 9548 9658 9813 9825 9922 9924 9927}';
    results.push(await syncRule(zoneId, 'LEGIT_PH_ASN_ONLY', `(not ${bypassExpression} and not ip.geoip.asnum in ${legitAsns})`, 'block', enableAsnWhitelist));

    // 4. Country Whitelist Rule (Customizable list of countries)
    const effectiveWhitelisted = whitelistedCountries.length > 0 ? whitelistedCountries : ["XX"];
    const countryList = `{"${effectiveWhitelisted.join('" "')}"}`;
    results.push(await syncRule(zoneId, 'COUNTRY_WHITELIST', `(not ${bypassExpression} and not ip.geoip.country in ${countryList})`, 'block', enableCountryWhitelist));

    const failed = results.find(r => !r.success);
    return failed ? failed : { success: true };
};

/**
 * 8. Get WAF Rule Status
 */
const getWafStatus = async (zoneId) => {
    try {
        const response = await axios.get(`${BASE_URL}/zones/${zoneId}/firewall/rules`, { headers });
        const status = {
            phOnly: false,
            vpnBlocking: false,
            asnWhitelist: false,
            countryWhitelist: false
        };

        if (response.data.success) {
            for (const rule of response.data.result) {
                if (rule.description === 'PH_ONLY_PROTECTION' && !rule.paused) status.phOnly = true;
                if (rule.description === 'VPN_PROXY_PROTECTION' && !rule.paused) status.vpnBlocking = true;
                if (rule.description === 'LEGIT_PH_ASN_ONLY' && !rule.paused) status.asnWhitelist = true;
                if (rule.description === 'COUNTRY_WHITELIST' && !rule.paused) status.countryWhitelist = true;
            }
        }
        return { success: true, status };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

module.exports = {
    addZone,
    getZoneId,
    listZones,
    setDnsRecord,
    getDnsRecords,
    autoSetup,
    setSecurityLevel,
    updateWafRules,
    getWafStatus,
    syncRule
};
