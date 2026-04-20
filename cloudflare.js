
require('dotenv').config();
const axios = require('axios');

const CF_EMAIL = process.env.CF_EMAIL;
const CF_API_KEY = process.env.CF_API_KEY;
const TARGET_IP = process.env.TARGET_SERVER_IP;

const BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_COUNTRY_WHITELIST = ['PH', 'SG', 'HK', 'JP', 'KW', 'SA', 'AE', 'QA', 'OM', 'BH'];
const DEFAULT_VPN_BLOCKED_ASNS = [9009, 13678, 60068, 16276, 14061, 202425, 212238, 32097, 206264, 49392, 50673, 211252, 205016, 39351, 209533, 210558, 13375, 20473, 14576, 14618, 16509, 20473, 45102, 16276, 62567, 12876, 24940, 36352, 15169, 8075, 20940, 54113, 25017, 396982, 204428];
const LEGIT_PH_ASNS = [10139, 131173, 131175, 13123, 131932, 132044, 132064, 132148, 132199, 132203, 132233, 132796, 133064, 133202, 133203, 133204, 133205, 133464, 134687, 134707, 134996, 135421, 135423, 135607, 136557, 137404, 138354, 138965, 139831, 140608, 141253, 141381, 147040, 17534, 17639, 17651, 17721, 17855, 17887, 17970, 18101, 18151, 18190, 18206, 18260, 23930, 23944, 24492, 24513, 32212, 3550, 38227, 38734, 45117, 45383, 45456, 45479, 45542, 45632, 45638, 45667, 45754, 45949, 4608, 4759, 4768, 4775, 4777, 4786, 4795, 4801, 4811, 55547, 55670, 55821, 56099, 56207, 6648, 7629, 7635, 9299, 9317, 9467, 9548, 9658, 9813, 9825, 9922, 9924, 9927];

const headers = {
    'X-Auth-Email': CF_EMAIL,
    'X-Auth-Key': CF_API_KEY,
    'Content-Type': 'application/json'
};

const formatCfSet = (values) => `{${values.join(' ')}}`;

const formatCountrySet = (countries) => `{"${countries.join('" "')}"}`;

const parseIpList = (value = '') =>
    String(value || '')
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean);

const parseNumericList = (value = '') =>
    String(value || '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item) && item > 0);

const uniqueIps = (ips) => [...new Set(ips.filter(Boolean))];

const uniqueNumbers = (items) => [...new Set(items.filter((item) => Number.isInteger(item) && item > 0))];

const getServerBypassIps = () =>
    uniqueIps([TARGET_IP, process.env.SSH_HOST].filter(Boolean));

const getPriorityBypassIps = () =>
    uniqueIps([
        ...parseIpList(process.env.CF_PRIORITY_BYPASS_IPS),
        ...getServerBypassIps()
    ]);

const getWafBypassIps = () =>
    uniqueIps([
        ...getPriorityBypassIps(),
        ...parseIpList(process.env.CF_WAF_BYPASS_IPS)
    ]);

const getVpnBlockedAsns = () => {
    const envAsns = uniqueNumbers(parseNumericList(process.env.CF_VPN_BLOCKED_ASNS));
    return envAsns.length > 0 ? envAsns : DEFAULT_VPN_BLOCKED_ASNS;
};

const getEffectiveWhitelistedCountries = (whitelistedCountries) => {
    if (!Array.isArray(whitelistedCountries)) {
        return DEFAULT_COUNTRY_WHITELIST;
    }

    return whitelistedCountries.length > 0 ? whitelistedCountries : ['XX'];
};

const buildWafRuleConfig = (type, options = {}) => {
    const bypassIps = getWafBypassIps();
    const bypassExpression = bypassIps.length > 0
        ? `(ip.src in ${formatCfSet(bypassIps)})`
        : null;
    const withBypass = (condition) =>
        bypassExpression ? `(not ${bypassExpression} and ${condition})` : `(${condition})`;

    if (type === 'ph_only') {
        return {
            ruleName: 'PH_ONLY_PROTECTION',
            expression: withBypass('ip.geoip.country ne "PH"'),
            action: 'block',
            displayName: 'PH Only Check'
        };
    }

    if (type === 'vpn') {
        const vpnBlockedAsns = getVpnBlockedAsns();
        return {
            ruleName: 'VPN_PROXY_PROTECTION',
            expression: withBypass(`ip.geoip.asnum in ${formatCfSet(vpnBlockedAsns)}`),
            action: 'block',
            displayName: 'VPN/Proxy Check'
        };
    }

    if (type === 'asn') {
        return {
            ruleName: 'LEGIT_PH_ASN_ONLY',
            expression: withBypass(`not ip.geoip.asnum in ${formatCfSet(LEGIT_PH_ASNS)}`),
            action: 'block',
            displayName: 'PH ASN Check'
        };
    }

    if (type === 'country') {
        const effectiveWhitelisted = getEffectiveWhitelistedCountries(
            options.whitelistedCountries
        );

        return {
            ruleName: 'COUNTRY_WHITELIST',
            expression: withBypass(`not ip.geoip.country in ${formatCountrySet(effectiveWhitelisted)}`),
            action: 'block',
            displayName: 'Country Whitelist'
        };
    }

    return null;
};

const ensureZoneIpAccessRule = async (zoneId, ip, notes = 'Auto bypass IP via env config') => {
    try {
        const response = await axios.get(
            `${BASE_URL}/zones/${zoneId}/firewall/access_rules/rules`,
            {
                headers,
                params: {
                    'configuration.target': 'ip',
                    'configuration.value': ip,
                    per_page: 100
                }
            }
        );

        const existingRule = response.data.success
            ? response.data.result.find(
                (rule) =>
                    rule.configuration?.target === 'ip' &&
                    rule.configuration?.value === ip
            )
            : null;
        const payload = {
            mode: 'whitelist',
            configuration: {
                target: 'ip',
                value: ip
            },
            notes
        };

        if (existingRule) {
            if (existingRule.mode === 'whitelist') {
                return { success: true, skipped: true };
            }

            const ruleId = existingRule.id || existingRule.identifier;
            const updateResponse = await axios.patch(
                `${BASE_URL}/zones/${zoneId}/firewall/access_rules/rules/${ruleId}`,
                payload,
                { headers }
            );

            return { success: updateResponse.data.success, updated: true };
        }

        const createResponse = await axios.post(
            `${BASE_URL}/zones/${zoneId}/firewall/access_rules/rules`,
            payload,
            { headers }
        );

        return { success: createResponse.data.success, created: true };
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.message;
        return { success: false, message: msg };
    }
};

const ensurePriorityBypassIps = async (zoneId, ips = getPriorityBypassIps()) => {
    if (!zoneId) {
        return { success: false, message: 'No Zone ID provided' };
    }

    const effectiveIps = Array.isArray(ips) ? uniqueIps(ips) : getPriorityBypassIps();
    if (effectiveIps.length === 0) {
        return { success: true, skipped: true, results: [] };
    }

    const results = [];
    for (const ip of effectiveIps) {
        results.push(await ensureZoneIpAccessRule(zoneId, ip));
    }

    const failed = results.find((result) => !result.success);
    return failed ? failed : { success: true, results };
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
            const bypassResult = await ensurePriorityBypassIps(response.data.result.id);
            if (!bypassResult.success) {
                console.error(`[CF_ERROR] ensurePriorityBypassIps addZone ${domain}:`, bypassResult.message);
            }

            return {
                success: true,
                zoneId: response.data.result.id,
                nameservers: response.data.result.name_servers,
                callbackBypassApplied: bypassResult.success,
                callbackBypassMessage: bypassResult.success ? '' : bypassResult.message
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
    const bypassResult = await ensurePriorityBypassIps(zoneId);
    if (!bypassResult.success) {
        console.error(`[CF_ERROR] ensurePriorityBypassIps autoSetup ${domain}:`, bypassResult.message);
    }
    
    return {
        success: dnsRes.success,
        domain: domain,
        zoneId: zoneId,
        ip: ip,
        nameservers: nameservers,
        message: dnsRes.success ? 'Domain added and pointed to IP successfully!' : dnsRes.message,
        callbackBypassApplied: bypassResult.success,
        callbackBypassMessage: bypassResult.success ? '' : bypassResult.message
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
const syncRule = async (zoneId, ruleName, expression, action, enabled, enforcePriorityBypass = true) => {
    try {
        console.log(`[CF] syncRule: ${ruleName}, enabled: ${enabled}`);

        if (enforcePriorityBypass) {
            const bypassResult = await ensurePriorityBypassIps(zoneId);
            if (!bypassResult.success) {
                return bypassResult;
            }
        }

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
        whitelistedCountries
    } = options;

    console.log(`[CF] updateWafRules:`, { zoneId, enablePhOnly, enableVpnBlocking, enableAsnWhitelist, enableCountryWhitelist, whitelistedCountries });

    if (!zoneId) return { success: false, message: 'No Zone ID provided' };

    const bypassResult = await ensurePriorityBypassIps(zoneId);
    if (!bypassResult.success) {
        return bypassResult;
    }

    const results = [];
    const ruleConfigs = [
        { enabled: enablePhOnly, config: buildWafRuleConfig('ph_only') },
        { enabled: enableVpnBlocking, config: buildWafRuleConfig('vpn') },
        { enabled: enableAsnWhitelist, config: buildWafRuleConfig('asn') },
        {
            enabled: enableCountryWhitelist,
            config: buildWafRuleConfig('country', { whitelistedCountries })
        }
    ];

    for (const ruleConfig of ruleConfigs) {
        results.push(
            await syncRule(
                zoneId,
                ruleConfig.config.ruleName,
                ruleConfig.config.expression,
                ruleConfig.config.action,
                ruleConfig.enabled,
                false
            )
        );
    }

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
    syncRule,
    buildWafRuleConfig,
    DEFAULT_COUNTRY_WHITELIST,
    ensurePriorityBypassIps,
    getPriorityBypassIps,
    getWafBypassIps
};
